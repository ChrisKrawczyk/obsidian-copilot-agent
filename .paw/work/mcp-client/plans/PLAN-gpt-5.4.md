# v0.5 MCP Client Integration — Draft Implementation Plan (gpt-5.4)

## Overview

v0.5 adds plugin-managed MCP client support to `obsidian-copilot-agent` without regressing the v0.4 baseline. The implementation should introduce a plugin-scope MCP control plane (persisted server config, transport/runtime manager, tool inventory snapshots, and settings UI), then bridge discovered MCP tools into the existing Copilot session/custom-tool surface, SafetyPolicy approval flow, ToolCallBlock rendering, and vault-aware preamble.

**Recommended dependency version:** add `@modelcontextprotocol/sdk@1.29.0` (latest stable 1.x verified via `npm view @modelcontextprotocol/sdk version` on 2026-06-15). Use client-only imports and tree-shaking-aware module boundaries so the bundle impact is explicit and measurable.

**Phase shippability invariant:** until Phase 5 lands, no MCP tool is injected into `AgentSession.tools` or the preamble. Phases 1–4 may persist config, enforce approval semantics, connect servers, and render Settings UI, but active chat behavior remains v0.4-equivalent unless the user deliberately enables the new MCP section and reaches the completed tool-bridge phase.

## Current State Analysis

- `src\domain\SafetyPolicy.ts:19-49,61-101,146-249` already reserves `SafetySource = "mcp"`, `SafetyState.grantMcp`, and `mcpAutoApprove`, but the grant scope is currently a single server-name string. v0.5 needs stable `{serverId, toolName}` scope plus trust-epoch revocation.
- `src\sdk\AgentSession.ts:625-760,1045-1338,1461-1809,2001-2023` already owns tool-call normalization, pending approvals, cancellation on reset/swap/dispose, approval prompt copy, preamble injection, and `buildSafetyInput()`. It currently recognizes native `kind === "mcp"` and maps MCP safety by `serverName` only; plugin-managed MCP wrappers must plug into this same surface without weakening the existing approval gate.
- `src\ui\ToolCallBlock.ts:45-55,79-180,183-271` already renders arguments, approval details, results, and errors as plain text with 4 KB truncation and only shows Undo when `undoId` is present. That is the correct anchor for FR-013 and FR-030.
- `src\domain\PreambleAssembler.ts:20-159` currently emits only vault-tool inventory and authoring conventions. It has no external-tool inventory or untrusted per-server instructions block yet.
- `src\settings\SafetySettingsStore.ts:23-225` and `src\settings\SettingsTab.ts:44-429` already provide the repo’s merge-safe plugin-data persistence pattern and the expected “store snapshot + subscribe + re-render section” settings pattern. MCP config and `mcpAutoApprove` should follow these conventions rather than inventing a parallel persistence style.
- `src\main.ts:79-99,211-279,293-438,651-738` is the correct wiring point for new plugin-scope services. It already instantiates shared stores, model catalog, per-conversation runtime factory, and unload disposal; MCP store/manager lifecycle should plug in here, not in `ChatView`.
- `src\sdk\ModelCatalog.ts:42-202`, `src\ui\ModelPicker.ts:33-140`, and `src\ui\modelPickerLogic.ts:20-239` establish a useful pattern for v0.5: pure shared state machine + thin DOM wrapper + targeted subscriptions. Reuse that split for MCP server state and settings validation where it keeps tests cheap.
- `src\persistence\PersistedShape.ts`, `src\persistence\migrate.ts`, `src\auth\TokenStore.ts`, and `src\settings\SafetySettingsStore.ts` confirm the repo’s rule that new persisted data must be additive, sibling-preserving, and resilient to partial/unknown fields.
- Verified baseline on the current checkout: `npm test` = 724/724 passing, `npm run typecheck` green, `npm run build` green.

## Desired End State

- Plugin `data.json` persists `mcpServers` as an additive top-level collection plus MCP auto-approval state keyed by stable server/tool identity; missing fields default safely; runtime-only state such as `Mcp-Session-Id`, child handles, timers, inventories, and in-flight calls are never persisted.
- A plugin-scope MCP manager owns enabled stdio and Streamable HTTP server lifecycles, protocol negotiation, bounded `tools/list` discovery, status/last-error snapshots, reconnect policy, and safe teardown.
- The Settings tab gains an `MCP Servers` section that lets users add, edit, remove, enable, disable, reconnect, and inspect servers; it redacts saved Authorization headers, confirms private-network risk, and shows deterministic connection state and last-error text.
- Every discovered MCP tool is surfaced into the Copilot session under a deterministic synthetic id `mcp__<server-id>__<tool-name>` with collision rejection, clear server attribution, stable approval scope, and no Undo affordance.
- `SafetyPolicy`, `SafetyState`, `AgentSession.buildSafetyInput()`, `ToolCallBlock`, and the approval prompt path treat MCP tools as first-class untrusted tools: approval by default, `mcpAutoApprove`/session-grant exceptions only for exact stable server/tool identity, escaped prompt rendering, and 4 KB argument display truncation.
- `PreambleAssembler` gains an MCP block that lists synthetic inventory as `<tool-name> (MCP / <display-name>)` plus per-server `instructions` truncated to 4 KB and clearly delimited as untrusted server-authored context.
- Crash/disconnect/timeout/oversize/list-changed paths are deterministic, bounded, and locally observable; built-in vault tools, model picker, token rotation, chat streaming, Stop, Undo, and no-MCP operation remain intact.

### Verification Approach

- **Automated:** focused Vitest coverage for persistence/store shape, safety/approval scope, URL/env policy, protocol/version negotiation, pagination and caps, server runtime lifecycle, settings validation/UI, tool registry/bridge, result normalization, preamble output, cancellation, reconnect/crashloop logic, and no-MCP baseline regressions.
- **Manual:** run the 19 success criteria from `Spec.md` in grouped smoke passes: stdio happy path, HTTP happy path, approval safety, failure/recovery, transport security, and additive baseline.

## What We're NOT Doing

- Acting as an MCP server.
- OAuth / PKCE for MCP servers.
- MCP resources, prompts, sampling, elicitation, roots, or server-initiated LLM calls.
- Registry browsing, auto-import from external MCP config files, or public-server discovery UX.
- Legacy HTTP+SSE fallback.
- Per-conversation MCP allowlists beyond existing per-call/per-session approval semantics.
- Telemetry, cost accounting, or remote audit reporting.
- Full image/audio passthrough to the model in v0.5.
- Undo journal entries for MCP tool calls.
- OS/container sandboxing beyond process/env/cwd/URL controls.

## Phase Status

- [ ] **Phase 1: Persistence shape + stable server identity** — Add additive storage for `mcpServers`, trust-epoch metadata, and persistent MCP auto-approval state without changing runtime behavior.
- [ ] **Phase 2: SafetyPolicy + universal approval gate for MCP identity** — Refactor approval scope to stable `{serverId, toolName}` and wire MCP synthetic ids through the existing approval/UI path early.
- [ ] **Phase 3: Transport/runtime substrate + bounded discovery** — Add the direct MCP client dependency and implement headless stdio/HTTP runtime management with explicit bounds and security policy.
- [ ] **Phase 4: Settings UI + plugin lifecycle orchestration** — Surface MCP server management in Settings and wire load/start/stop/reconnect/dispose through `main.ts`.
- [ ] **Phase 5: Tool bridge + preamble + result rendering** — Publish discovered tools into `AgentSession`, add MCP preamble inventory/instructions, convert results, and suppress Undo.
- [ ] **Phase 6: Recovery, notifications, cancellation, and crashloop handling** — Finish list-changed refresh, auto-reconnect, stale-session recovery, Stop/cancellation, and unload/failure determinism.
- [ ] **Phase 7: Documentation** — Capture the as-built design, user setup steps, and regression/smoke guidance.

## Phase Candidates

- [x] [skipped] OAuth / PKCE flows for hosted MCP servers.
- [x] [skipped] MCP resources, prompts, sampling, elicitation, or roots support.
- [x] [skipped] Legacy HTTP+SSE fallback or explicit SSE-only transport support.
- [x] [skipped] Per-conversation MCP server allowlists or model/tool routing policies.
- [x] [skipped] Full image/audio passthrough to the model instead of typed placeholders.
- [x] [skipped] Auto-import from `.mcp.json`, `.vscode\mcp.json`, Claude Desktop config, or registry browsing.
- [x] [skipped] Local sandbox/container isolation for stdio servers beyond the v0.5 env/cwd/process controls.
- [x] [skipped] Richer MCP diagnostics views (dedicated output pane, invocation history, local audit log) beyond required status/error/snippet visibility.

## Phase Ordering Rationale

1. **Persistence first** because every later phase depends on a stable config/identity model, and the repo already treats additive data-shape work as its own low-risk shippable increment.
2. **Safety second** because the first externally callable MCP tool must already route through a correct approval scope; landing transport code before identity-safe approval would create the wrong incentives and test shape.
3. **Transport third** because protocol/version/timeout/cap/security behavior is easiest to prove headlessly before any Obsidian DOM or chat integration is involved.
4. **Settings fourth** because the management UI is much simpler once the runtime surface and validation rules are already pinned by tests.
5. **Tool bridge fifth** because it sits on top of persistence, safety, runtime, and settings; only once those are stable should discovered inventories enter `AgentSession`, the preamble, and the model-facing tool list.
6. **Recovery sixth** because reconnect/list-changed/cancellation semantics cross transport, registry, and active sessions. They are lower-level correctness work that benefits from the happy path already being green.
7. **Documentation last** so README / CHANGELOG / Docs.md describe the final, as-built behavior rather than the pre-implementation intent.

---

## Phase 1: Persistence shape + stable server identity

### Goals

Add additive plugin-data storage for MCP server configs and persistent MCP approval state. Lock in the stable identity/trust-epoch model before any runtime or UI work lands.

### Files to add/edit

- **`src\settings\McpSettingsStore.ts`** (new): own top-level `mcpServers` persistence with the same merge-and-write discipline used by `TokenStore` and `SafetySettingsStore`.
- **`src\mcp\McpTypes.ts`** (new): define persisted transport/config/status types, stable `serverId`, display name, trust-epoch fingerprint, and redaction helpers.
- **`src\settings\SafetySettingsStore.ts`**: extend persisted safety shape with `mcpAutoApprove` keyed by stable server/tool identity plus helper methods to clear grants for a server on remove/repoint/rename.
- **`src\main.ts`**: instantiate and load `McpSettingsStore` alongside the other stores so later phases do not have to retrofit plugin startup ordering.

### Required tests

- **`src\settings\McpSettingsStore.test.ts`**: missing-field defaults to `[]`; round-trip stdio and HTTP configs; sibling top-level keys survive; Authorization persists but is omitted from redacted snapshots; runtime-only fields (session id, child pid, timers, inventory) never serialize.
- **`src\settings\SafetySettingsStore.test.ts`**: `mcpAutoApprove` round-trips as nested server/tool identity state; revoke helpers clear one server without disturbing unrelated built-in or vault settings.
- **`src\settings\McpSettingsStore.test.ts`**: trust-epoch rotation is triggered when `name`, `command`, `args`, or `url` changes; pure edits to enable/disable or error text do not create a false rotation.

### Quality gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual verification checklist

- [ ] **SC-012:** Save one stdio and one HTTP server, reload Obsidian, and confirm both configs plus the static Authorization header survive in `data.json` while no `Mcp-Session-Id` or runtime-only transport state is written.
- [ ] **SC-019:** Rename a server, then change its command/args/url, and confirm persistent MCP auto-approval entries for that server are revoked exactly once; removing the server clears the remainder.
- [ ] **SC-005:** Leave `mcpServers` empty (or all disabled) and confirm chat startup, model picker, token reuse, Undo, and vault tools behave exactly like v0.4.

### Risks & Mitigations

- **Risk:** clobbering sibling keys in `data.json`. **Mitigation:** follow the existing re-read + merge + save pattern already proven by `TokenStore` and `SafetySettingsStore`, with explicit tests covering `auth`, `settings`, `safety`, and `conversations`.
- **Risk:** choosing an unstable trust-identity model. **Mitigation:** pin a single persisted fingerprint rule now and make all later revocation logic consume that same helper rather than rebuilding it ad hoc in UI/runtime code.

---

## Phase 2: SafetyPolicy + universal approval gate for MCP identity

### Goals

Refactor the existing approval model so MCP grants are keyed by stable server/tool identity, not mutable display strings, and so plugin-managed MCP tool wrappers can enter the same approval/UI flow as built-ins and vault tools.

### Files to add/edit

- **`src\mcp\McpToolIdentity.ts`** (new): format/parse `mcp__<server-id>__<tool-name>` ids and expose lookup types shared by settings, registry, and `AgentSession`.
- **`src\domain\SafetyPolicy.ts`**: replace server-name-only MCP grants with exact `{serverId, toolName}` scope, persistent allowlist lookup, and server-level revoke hooks.
- **`src\sdk\AgentSession.ts`**: extend `buildSafetyInput()`, `classifyToolSource()`, approval summary/detail builders, and pending-approval resolution so synthetic MCP tools resolve to `source: "mcp"` with exact stable identity.
- **`src\domain\types.ts`**: carry the MCP-facing metadata needed by `ToolCallBlock` and tests without coupling the domain layer to the MCP SDK client.
- **`src\ui\ToolCallBlock.ts`**: keep using plain-text rendering and 4 KB truncation, but make the MCP source/labeling explicit and ensure no Undo path appears for MCP outcomes even when future callers accidentally provide an `undoId`.

### Required tests

- **`src\domain\SafetyPolicy.test.ts`**: exact-match MCP approval by `(serverId, toolName)`; no approval leakage across tools on the same server; renames/repoints require re-approval; `readOnlyHint`-like metadata never bypasses approval.
- **`src\sdk\AgentSession.test.ts`**: synthetic MCP ids are classified as `source: "mcp"`; approval copy uses stable server display/tool names; `approve-for-session` grants only the selected MCP tool scope; `cancelAllPendingApprovals()` still works unchanged.
- **`src\ui\ToolCallBlock.test.ts`**: approval detail remains escaped plain text; 4 KB truncation marker appears; MCP blocks never render Undo; vault-write Undo remains untouched.

### Quality gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual verification checklist

- [ ] **SC-003:** With two MCP tools on the same server, approve one for the session and confirm only that exact tool stops prompting; the sibling tool still prompts.
- [ ] **SC-004:** Use malicious server/tool names and large JSON arguments, trigger an approval prompt, and confirm the modal shows escaped plain text with a visible truncation marker at 4 KB.
- [ ] **SC-019:** After changing a server identity field, confirm the previously auto-approved MCP tool prompts again on the next attempt.

### Risks & Mitigations

- **Risk:** accidentally breaking vault/built-in approval behavior while widening `SafetyPolicyInput`. **Mitigation:** keep the existing `vault`/`builtin` code paths structurally intact and add regression assertions for current write/built-in cases in the same test suite.
- **Risk:** synthetic-id parsing becomes duplicated across files. **Mitigation:** centralize it in `McpToolIdentity.ts` and make every caller consume the same helper.

---

## Phase 3: Transport/runtime substrate + bounded discovery

### Goals

Add the direct MCP client dependency and implement plugin-owned stdio/Streamable HTTP runtime management with explicit protocol, timeout, size, and security policy. This phase is headless: no Settings UI or chat surfacing yet.

### Files to add/edit

- **`package.json` / `package-lock.json`**: add `@modelcontextprotocol/sdk@1.29.0`.
- **`src\mcp\stdioEnv.ts`** (new): implement full-inherit-minus-denylist env filtering, explicit per-server env injection, Windows case-insensitive matching, and macOS PATH prepending.
- **`src\mcp\httpPolicy.ts`** (new): validate URLs, reject metadata hosts, confirm private-network targets, enforce redirect policy, and redact session-id/header values from diagnostics.
- **`src\mcp\McpServerRuntime.ts`** (new): own one server connection’s initialize/initialized lifecycle, version/capability checks, `tools/list` pagination, instructions cache, timeouts, and bounded I/O/error surfaces.
- **`src\mcp\McpManager.ts`** (new): own the enabled-server map, immutable inventory snapshots, and runtime-level status/last-error state without yet wiring it into chat sessions.
- **`src\main.ts`**: instantiate the manager with the loaded MCP settings store and Notice/log callbacks, but keep chat integration off until Phase 5.

### Required tests

- **`src\mcp\stdioEnv.test.ts`**: deny exact keys/patterns (`GITHUB_TOKEN`, `GH_TOKEN`, `COPILOT_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_*`, `GCP_*`, `*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`); explicit per-server env injection occurs after filtering; macOS PATH begins with `/usr/local/bin` and `/opt/homebrew/bin`.
- **`src\mcp\httpPolicy.test.ts`**: reject non-loopback plaintext HTTP; reject metadata hosts/IPs; require confirmation for private/link-local destinations; strip Authorization on cross-origin redirect; cap redirects at 3.
- **`src\mcp\McpServerRuntime.test.ts`**: advertise `2025-06-18`; accept `2025-06-18` and `2024-11-05` only over stdio/Streamable HTTP framing; reject legacy HTTP+SSE; handle tools-absent servers; follow paginated `tools/list` with 10 s page timeout and 50-page/1000-tool caps.
- **`src\mcp\McpManager.test.ts`**: 10 s initialize timeout, default 60 s call timeout capped at 300 s, 16 MiB frame/body/SSE caps, 64 KiB stderr ring buffer, and no persistence of `Mcp-Session-Id`.

### Quality gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual verification checklist

- [ ] **SC-009:** Launch a reference stdio server with a hostile ambient environment and confirm denied secrets are absent, explicit env entries are present, macOS PATH is amended, and absolute command paths still work.
- [ ] **SC-013:** Use fake transports that never answer initialize/list/call and confirm deterministic timeout errors at 10 s / 10 s / configured call timeout.
- [ ] **SC-014:** Feed oversized stdio lines, HTTP bodies, SSE streams, and stderr output; confirm deterministic failure plus last-64-KiB diagnostics only.
- [ ] **SC-017:** Attempt loopback, private-network, metadata-host, and public HTTPS URLs and confirm the correct reject/confirm/allow behavior.
- [ ] **SC-018:** Verify `2024-11-05` stdio and Streamable HTTP servers succeed while legacy SSE-only fixtures fail with the expected unsupported-transport error.
- [ ] **SC-012:** Confirm HTTP session ids remain in-memory only across connect/disconnect cycles.

### Risks & Mitigations

- **Risk:** transport abstraction leaks UI concerns. **Mitigation:** keep `McpServerRuntime` and `McpManager` DOM-free and surface only typed status/inventory snapshots.
- **Risk:** bundle delta exceeds the NFR-005 sanity budget. **Mitigation:** constrain imports to client-only MCP SDK entry points and record the measured build delta during this phase before any UI noise obscures it.

---

## Phase 4: Settings UI + plugin lifecycle orchestration

### Goals

Expose MCP server configuration and lifecycle management in Settings, and wire manager startup/shutdown/reconnect behavior into plugin load/unload without affecting no-MCP baseline users.

### Files to add/edit

- **`src\settings\mcpServerFormLogic.ts`** (new): pure validation and normalization for add/edit forms (required fields, slug/id rules, timeout bounds, URL policy outcomes).
- **`src\settings\McpServersSection.ts`** (new): DOM rendering for the `MCP Servers` section, reusing the repo’s small-overlay/modal patterns for add/edit/remove/confirm flows.
- **`src\settings\SettingsTab.ts`**: mount the MCP section, subscribe to the manager/store, show redacted Authorization values, and surface reconnect/enable/disable/remove affordances with meaningful labels.
- **`src\main.ts`**: load the MCP settings snapshot on startup, start enabled servers asynchronously, keep chat usable if a server fails, and dispose all runtime connections on unload.
- **`src\settings\McpSettingsStore.ts`**: add the minimal mutation helpers (`addServer`, `updateServer`, `removeServer`, `setEnabled`, `setLastError`) the UI/controller layer needs.

### Required tests

- **`src\settings\mcpServerFormLogic.test.ts`**: required stdio/HTTP fields, slug uniqueness, timeout bounds, URL validation outcomes, and redaction/reveal semantics.
- **`src\settings\McpServersSection.test.ts`**: add/edit/remove/enable/disable/reconnect flows, private-network confirmation, status/last-error rendering, and one-shot grant-revocation notices.
- **`src\main.mcpLifecycle.test.ts`**: enabled servers start after plugin load without blocking baseline chat; disabled servers do nothing; unload disposes the manager exactly once.

### Quality gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual verification checklist

- [ ] **SC-012:** Add an HTTP server with Authorization, reload the plugin, and confirm the saved header is redacted by default but survives reload/edit/remove correctly.
- [ ] **SC-017:** Add private-network and metadata-host HTTP configs and confirm the private-network confirmation modal and metadata-host rejection are visible in Settings.
- [ ] **SC-019:** Remove or repoint a server from Settings and confirm stale persistent grants are revoked and a one-shot Notice is shown.
- [ ] **SC-005:** Leave no servers configured (or disable them all) and confirm startup remains fast and baseline chat UX is unchanged.

### Risks & Mitigations

- **Risk:** `SettingsTab.ts` becomes too large and hard to test. **Mitigation:** isolate MCP-specific validation/rendering into new `McpServersSection` and `mcpServerFormLogic` modules, following the same split used by `ModelPicker`.
- **Risk:** startup work regresses perceived plugin load time. **Mitigation:** manager connect attempts run asynchronously after the existing store/auth bootstrap, and the empty/disabled path stays a no-op.

---

## Phase 5: Tool bridge + preamble + result rendering

### Goals

Bridge discovered MCP inventories into the existing Copilot session/custom-tool surface, surface server-attributed inventory in the preamble, convert MCP results for the model/UI, and preserve the no-Undo safety posture.

### Files to add/edit

- **`src\mcp\McpToolRegistry.ts`** (new): maintain the immutable snapshot that maps synthetic id `mcp__<server-id>__<tool-name>` to server/tool metadata, collision rules, and current inventory version.
- **`src\mcp\McpToolBridge.ts`** (new): expose discovered MCP tools as SDK custom tools whose handlers delegate to `McpManager.callTool()`, then convert MCP results into the existing tool-result surface.
- **`src\mcp\normalizeMcpResult.ts`** (new): normalize text/structured/error/binary content, including v0.5 placeholders for image/audio/blob data and readable rendering of structured content.
- **`src\sdk\AgentSession.ts`**: accept an MCP registry lookup so synthetic custom-tool names classify as `source: "mcp"` for approval, tool-call lifecycle, and UI rendering.
- **`src\main.ts`**: inject the current MCP tool snapshot into each new conversation runtime and define how inventory version changes are handed off to live runtimes only between turns.
- **`src\domain\PreambleAssembler.ts`**: add an MCP inventory/instructions block with per-server 4 KB truncation and explicit untrusted-content delimiters.
- **`src\domain\types.ts`** and **`src\ui\ToolCallBlock.ts`**: surface MCP server attribution and keep Undo absent for MCP outcomes.

### Required tests

- **`src\mcp\McpToolRegistry.test.ts`**: cross-server duplicate tool names produce distinct synthetic ids; same-server duplicates reject that server inventory; built-in collisions reject MCP registration and preserve built-ins.
- **`src\mcp\McpToolBridge.test.ts`**: approved calls route to the originating server/tool; MCP execution errors and JSON-RPC errors render distinct failure surfaces; no `undoId` is emitted.
- **`src\mcp\normalizeMcpResult.test.ts`**: text + structured content render cleanly; image/audio/blob/resource payloads become typed placeholders with byte counts when possible; base64 is not passed through as raw chat text.
- **`src\domain\PreambleAssembler.test.ts`**: inventory rows render as `<tool-name> (MCP / <display-name>)`; per-server instructions truncate at 4 KB; absent instructions omit cleanly; no-MCP preamble remains unchanged.
- **`src\sdk\AgentSession.test.ts`** and **`src\ui\ToolCallBlock.test.ts`**: MCP synthetic tools still go through approval, render as source `mcp`, and never show Undo.

### Quality gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual verification checklist

- [ ] **SC-001:** Configure a reference stdio server, reconnect it, confirm the preamble lists `<tool-name> (MCP / <display-name>)`, approve one call, and confirm the result appears without an Undo button.
- [ ] **SC-002:** Configure a Streamable HTTP server with Authorization, discover two pages of tools, approve one call, and confirm the correct server handles it.
- [ ] **SC-003:** Confirm MCP calls still prompt by default even when the server advertises read-only annotations.
- [ ] **SC-004:** Trigger a malicious approval prompt and confirm escaped plain text plus 4 KB truncation in the inline UI.
- [ ] **SC-011:** Execute a tool returning mixed text plus binary image/audio content and confirm the UI shows placeholders instead of raw base64.
- [ ] **SC-016:** Connect two servers exposing `read_file`, confirm both appear under distinct synthetic ids, and verify built-in collisions are rejected.

### Risks & Mitigations

- **Risk:** tool registration and approval identity drift apart. **Mitigation:** make `McpToolRegistry` the single source of truth for synthetic ids, server display names, raw tool names, and approval scope.
- **Risk:** preamble instructions create prompt-injection ambiguity. **Mitigation:** isolate MCP instructions in clearly-labeled untrusted blocks and keep approval policy entirely outside preamble content.

---

## Phase 6: Recovery, notifications, cancellation, and crashloop handling

### Goals

Finish the resilience surface: list-changed refresh, auto-reconnect, stale-session recovery, Stop/cancellation, late-response discard, deterministic shutdown, and continued usability of built-in tools after MCP failures.

### Files to add/edit

- **`src\mcp\McpNotificationQueue.ts`** (new): coalesce `notifications/tools/list_changed` per server and schedule refresh only after in-flight calls settle.
- **`src\mcp\McpReconnectPolicy.ts`** (new): own the 1/2/4/8/16/32/60-second stdio retry schedule, 5-attempts-in-5-minutes crashloop cap, and reset-on-success behavior.
- **`src\mcp\McpManager.ts`**: integrate notification coalescing, reconnect policy, stale HTTP session-id handling, late-response discard, and teardown ordering for disable/remove/reconnect/unload.
- **`src\mcp\McpToolBridge.ts`**: propagate Stop/cancellation into pending tool calls and synthesize deterministic error/cancel surfaces when transports die mid-call.
- **`src\sdk\AgentSession.ts`** and **`src\main.ts`**: ensure runtime cancellation/dispose/reconnect ordering does not leave pending approvals or hanging promises when MCP failures occur.

### Required tests

- **`src\mcp\McpNotificationQueue.test.ts`**: three `tools/list_changed` notifications during one in-flight call coalesce into one post-call refresh with no partial registry state.
- **`src\mcp\McpReconnectPolicy.test.ts`**: retry schedule 1/2/4/8/16/32/60, reset on successful initialize, crashloop after the fifth failed attempt within five minutes, manual reconnect clears crashloop.
- **`src\mcp\McpManager.resilience.test.ts`**: stdio exit mid-call, HTTP drop mid-call, stale-session 404, bounded HTTP DELETE on shutdown, in-flight rejection on disable/remove/reconnect, built-in tools still usable after MCP failure.
- **`src\mcp\McpToolBridge.test.ts`** and **`src\sdk\AgentSession.test.ts`**: Stop sends cancellation when possible, cancelled UI state is terminal, and late responses are ignored.
- **`src\main.mcpLifecycle.test.ts`**: unload closes stdin, then SIGTERM, then SIGKILL on stubborn stdio children without orphaning tracked processes.

### Quality gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual verification checklist

- [ ] **SC-006:** Kill a stdio server mid-call and confirm the call errors cleanly, built-in tools still work, and the first reconnect attempt starts after 1 second.
- [ ] **SC-007:** Drop an HTTP call connection and confirm there is no background reconnect loop; the next MCP call triggers a fresh initialize.
- [ ] **SC-008:** Fire three `tools/list_changed` notifications during one delayed call and confirm no mid-call refresh plus exactly one atomic refresh after the call completes.
- [ ] **SC-010:** Unload the plugin with stubborn stdio children and confirm stdin close → 5 s → SIGTERM → 5 s → SIGKILL with no orphaned processes.
- [ ] **SC-013:** Reconfirm timeout behavior after cancellation/reconnect logic lands so retries do not hide deterministic timeout failures.
- [ ] **SC-015:** Force repeated stdio initialize failures and confirm the server reaches `crashloop`; manual Reconnect resets the state and allows a later success.

### Risks & Mitigations

- **Risk:** reconnect/list-changed work mutates session-visible tool state mid-turn. **Mitigation:** queue refresh application behind the current in-flight turn and publish inventory snapshots atomically.
- **Risk:** unload or disable leaks hanging promises or child processes. **Mitigation:** define one authoritative shutdown path in `McpManager` and have all callers route through it.

---

## Phase 7: Documentation

### Goals

Capture the final design, setup expectations, supported transports, security posture, and regression/smoke procedure once the feature is fully implemented.

### Files to add/edit

- **`.paw\work\mcp-client\Docs.md`**: as-built technical reference, architecture summary, settings fields, trust/approval behavior, diagnostics, and verification notes.
- **`README.md`**: user-facing setup for stdio and Streamable HTTP servers, Windows `cmd /c npx` guidance, private-network warning posture, and no-Undo caveat for MCP tools.
- **`CHANGELOG.md`**: v0.5 feature summary, bundle-size note/waiver if needed, and major compatibility/security caveats.

### Required tests

- **Docs review only:** no separate docs build tool exists today; validate examples and command names against the implemented code and keep the standard repo gates green.

### Quality gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual verification checklist

- [ ] **SC-001 / SC-002:** README setup steps reproduce one working stdio server and one working Streamable HTTP server without hidden steps.
- [ ] **SC-005:** Docs explicitly state that no configured/disabled MCP servers leave v0.4 behavior unchanged.
- [ ] **SC-017 / SC-018:** Docs call out private-network confirmation, metadata-host rejection, and the lack of legacy HTTP+SSE fallback.

### Risks & Mitigations

- **Risk:** docs drift from the as-built implementation. **Mitigation:** write Docs.md last and derive examples from the shipped code paths/tests, not the original spec prose.

---

## Requirements Traceability Matrix

### Functional Requirements

| Requirement | Summary | Phase(s) | Primary tests |
|---|---|---:|---|
| FR-001 | Persist `mcpServers` in plugin data | 1 | `McpSettingsStore.test.ts`, `SafetySettingsStore.test.ts` |
| FR-002 | Add/edit/remove/enable/disable/reconnect UI | 4 | `McpServersSection.test.ts`, `main.mcpLifecycle.test.ts` |
| FR-003 | Static HTTP Authorization header | 1, 4 | `McpSettingsStore.test.ts`, `mcpServerFormLogic.test.ts`, `McpServersSection.test.ts` |
| FR-004 | Stdio transport | 3 | `stdioEnv.test.ts`, `McpServerRuntime.test.ts` |
| FR-005 | Streamable HTTP only | 3 | `httpPolicy.test.ts`, `McpServerRuntime.test.ts` |
| FR-006 | Protocol version negotiation | 3 | `McpServerRuntime.test.ts` |
| FR-007 | Capabilities negotiation | 3 | `McpServerRuntime.test.ts` |
| FR-008 | Full `tools/list` pagination with bounds | 3 | `McpServerRuntime.test.ts`, `McpManager.test.ts` |
| FR-009 | Deterministic SDK tool registration | 5 | `McpToolRegistry.test.ts`, `AgentSession.test.ts` |
| FR-010 | Preamble inventory + instructions | 5 | `PreambleAssembler.test.ts`, `McpToolRegistry.test.ts` |
| FR-011 | Universal permission gate routing | 2, 5 | `SafetyPolicy.test.ts`, `AgentSession.test.ts`, `ToolCallBlock.test.ts` |
| FR-012 | MCP auto-approval allowlist | 1, 2, 4 | `SafetySettingsStore.test.ts`, `SafetyPolicy.test.ts`, `McpServersSection.test.ts` |
| FR-013 | MCP calls are not undoable | 2, 5 | `ToolCallBlock.test.ts`, `McpToolBridge.test.ts` |
| FR-014 | Tool-call execution + result rendering | 5 | `McpToolBridge.test.ts`, `normalizeMcpResult.test.ts`, `ToolCallBlock.test.ts` |
| FR-015 | Binary/image placeholders | 5 | `normalizeMcpResult.test.ts` |
| FR-016 | Crash/disconnect resilience | 6 | `McpManager.resilience.test.ts`, `McpToolBridge.test.ts` |
| FR-017 | Manual reconnect | 4, 6 | `McpServersSection.test.ts`, `McpManager.resilience.test.ts` |
| FR-018 | Bounded stdio auto-reconnect | 6 | `McpReconnectPolicy.test.ts`, `McpManager.resilience.test.ts` |
| FR-019 | HTTP session-id lifecycle | 3, 6 | `McpManager.test.ts`, `McpManager.resilience.test.ts` |
| FR-020 | Coalesced `list_changed` refresh | 6 | `McpNotificationQueue.test.ts`, `McpManager.resilience.test.ts` |
| FR-021 | Cancellation and Stop | 6 | `McpToolBridge.test.ts`, `AgentSession.test.ts`, `McpManager.resilience.test.ts` |
| FR-022 | Stdio environment filtering | 3 | `stdioEnv.test.ts` |
| FR-023 | macOS PATH amendment | 3 | `stdioEnv.test.ts` |
| FR-024 | Stdio shutdown sequence | 3, 6 | `McpManager.test.ts`, `main.mcpLifecycle.test.ts` |
| FR-025 | HTTP URL/TLS/redirect posture | 3, 4 | `httpPolicy.test.ts`, `mcpServerFormLogic.test.ts` |
| FR-026 | MCP-disabled baseline | 1, 4, 5, 6 | `main.mcpLifecycle.test.ts`, full `npm test` suite |
| FR-027 | Request timeout policy | 3, 6 | `McpManager.test.ts`, `McpManager.resilience.test.ts` |
| FR-028 | Bounded I/O and diagnostics caps | 3 | `McpManager.test.ts`, `McpServerRuntime.test.ts` |
| FR-029 | `2024-11-05` compatibility / legacy SSE rejection | 3 | `McpServerRuntime.test.ts` |
| FR-030 | Safe approval prompt rendering | 2, 5 | `AgentSession.test.ts`, `ToolCallBlock.test.ts` |

### Non-Functional Requirements

| Requirement | Summary | Phase(s) | Primary tests / checks |
|---|---|---:|---|
| NFR-001 | Performance and bounded latency | 3, 6 | `McpServerRuntime.test.ts`, `McpManager.test.ts`, manual SC-013 timing smoke |
| NFR-002 | Resilience and bounded resources | 3, 6 | `McpManager.test.ts`, `McpManager.resilience.test.ts`, `McpReconnectPolicy.test.ts` |
| NFR-003 | Security posture | 1, 2, 3, 4, 5 | store tests, `SafetyPolicy.test.ts`, `stdioEnv.test.ts`, `httpPolicy.test.ts`, UI redaction tests |
| NFR-004 | Protocol/transport compatibility | 3 | `McpServerRuntime.test.ts` |
| NFR-005 | Bundle size sanity check | 3, 7 | `npm run build`, measured bundle delta documented in `CHANGELOG.md` |
| NFR-006 | Accessibility | 4, 5 | `McpServersSection.test.ts`, `ToolCallBlock.test.ts`, manual keyboard smoke |
| NFR-007 | Baseline preservation | 1–6 | full `npm test`, targeted no-MCP smoke in `main.mcpLifecycle.test.ts` |
| NFR-008 | Local observability without telemetry | 3, 4, 6 | `McpManager.test.ts`, `McpServersSection.test.ts`, `McpManager.resilience.test.ts` |

### Success Criteria

| Success Criteria | Phase(s) | Primary tests / verification |
|---|---:|---|
| SC-001 | 4, 5 | `McpServersSection.test.ts`, `McpToolBridge.test.ts`, `PreambleAssembler.test.ts`, manual stdio smoke |
| SC-002 | 4, 5 | `McpServersSection.test.ts`, `McpToolBridge.test.ts`, `McpServerRuntime.test.ts`, manual HTTP smoke |
| SC-003 | 2, 5 | `SafetyPolicy.test.ts`, `AgentSession.test.ts`, manual approval-scope smoke |
| SC-004 | 2, 5 | `AgentSession.test.ts`, `ToolCallBlock.test.ts`, manual malicious-prompt smoke |
| SC-005 | 1, 4, 5, 6 | full `npm test`, `main.mcpLifecycle.test.ts`, manual no-MCP smoke |
| SC-006 | 6 | `McpManager.resilience.test.ts`, manual stdio-crash smoke |
| SC-007 | 6 | `McpManager.resilience.test.ts`, manual HTTP-drop smoke |
| SC-008 | 6 | `McpNotificationQueue.test.ts`, manual delayed-call smoke |
| SC-009 | 3 | `stdioEnv.test.ts`, manual env/PATH smoke |
| SC-010 | 6 | `main.mcpLifecycle.test.ts`, manual unload smoke |
| SC-011 | 5 | `normalizeMcpResult.test.ts`, manual mixed-content smoke |
| SC-012 | 1, 3, 4 | `McpSettingsStore.test.ts`, `McpManager.test.ts`, `McpServersSection.test.ts`, manual reload smoke |
| SC-013 | 3, 6 | `McpManager.test.ts`, `McpManager.resilience.test.ts`, manual timeout smoke |
| SC-014 | 3 | `McpManager.test.ts`, `McpServerRuntime.test.ts`, manual oversized-payload smoke |
| SC-015 | 6 | `McpReconnectPolicy.test.ts`, manual crashloop smoke |
| SC-016 | 5 | `McpToolRegistry.test.ts`, manual duplicate-name smoke |
| SC-017 | 3, 4 | `httpPolicy.test.ts`, `mcpServerFormLogic.test.ts`, manual URL-policy smoke |
| SC-018 | 3 | `McpServerRuntime.test.ts`, manual protocol-matrix smoke |
| SC-019 | 1, 2, 4 | `SafetySettingsStore.test.ts`, `SafetyPolicy.test.ts`, `McpServersSection.test.ts`, manual trust-epoch smoke |

## References

- Spec: `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\Spec.md`
- Research: `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\SpecResearch.md`
- Workflow context: `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\WorkflowContext.md`
- Spec review synthesis: `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\reviews\SPEC-REVIEW-SYNTHESIS.md`
- Reviewer details: `SPEC-REVIEW-gpt-5.4.md`, `SPEC-REVIEW-gemini-3.1-pro-preview.md`, `SPEC-REVIEW-claude-opus-4.7.md`, `SPEC-REVIEW-PERSPECTIVE-operational-resilience.md`, `SPEC-REVIEW-PERSPECTIVE-security-threat-modeling.md`
- Style anchor: `C:\Repos\obsidian-copilot-agent\.paw\work\model-picker\ImplementationPlan.md`
- Verified code anchors:
  - `src\domain\SafetyPolicy.ts`
  - `src\sdk\AgentSession.ts`
  - `src\ui\ToolCallBlock.ts`
  - `src\domain\PreambleAssembler.ts`
  - `src\settings\SettingsTab.ts`
  - `src\settings\SafetySettingsStore.ts`
  - `src\main.ts`
  - `src\persistence\PersistedShape.ts`
  - `src\persistence\migrate.ts`
