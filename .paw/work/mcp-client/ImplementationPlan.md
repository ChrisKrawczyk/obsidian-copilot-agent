# v0.5 MCP Client Integration — Implementation Plan

<!-- Synthesized from plans/PLAN-gpt-5.4.md, plans/PLAN-gemini-3.1-pro-preview.md, and plans/PLAN-claude-opus-4.7.md. The per-model drafts remain in plans/ for traceability; this file is canonical from this point. -->

## Review-fix changelog

1. **MUST #1 → Phase 5 + Phase 6:** Phase 5 is now a clean stopping point by adding minimum viable resilience (60 s tool-call timeout, stderr ring-buffer failure surfacing, crash finalization, crashloop hard-disable, removed/disabled aborts, single-flight initialize) and Phase 6 is explicitly hardening + polish with added quality gates/manual checks.
2. **MUST #2 → Phase 3:** Added an exact NFR-005 gzip bundle delta gate when `@modelcontextprotocol/sdk@1.29.0` lands: ≤80 KB passes; >80 KB requires CHANGELOG waiver and tree-shaking notes.
3. **MUST #3 → Phase 1:** Added legacy/corrupt persistence rules: preserve pre-existing `mcpAutoApprove`, fail-closed missing/corrupt `mcpServers`, drop malformed entries with one-shot Notice, first-save cleanup, and preserve unknown future keys per server.
4. **MUST #4 → Phase 1 + Phase 2 + Phase 5:** Added server-id/tool-name parser rules, exact tool-name passthrough, current-trust-epoch grant lookup, removed/disabled fail-closed behavior, in-flight abort semantics, and control/null/path-separator rejection.
5. **MUST #5 → Phase 3:** Added exact SDK pinning, runtime custom fetch redirect/header/TLS enforcement, owned stdio spawn in `src\mcp\transport\StdioTransport.ts`, and Windows `.cmd`/`cmd /c` spawn tests.
6. **MUST #6 → Phase 5:** Added source-keyed `ToolCallBlock` Undo predicate (`has undoId && source !== "mcp"`) and a fake-undoId MCP regression test.
7. **MUST #7 → Phase 2 + Phase 6:** Added `redactSensitive(text)` helper, denylist/session-id tests, explicit display+persistence redaction inventory, and safe-render seams for settings last-error/stderr, tool-call args/results, approval modal, and preamble instructions.
8. **MUST #8 → Phase 6:** Added bounded unload/cancellation semantics: parallel shutdown with 20 s aggregate cap, forced kill and warning, pre-close cancelled settlement, initialize abort behavior, bounded non-cancelable discovery, and late-response discard.
9. **SHOULD #9 → Phase 3:** Added FR-007 capability assertions before `tools/list`; tools-absent servers are marked incompatible/zero-tools and never listed.
10. **SHOULD #10 → Phase 3:** Added FR-019 same-load `Mcp-Session-Id` round-trip/no-persist/drop-on-reload test.
11. **SHOULD #11 → Phase 3:** Added explicit FR-029 protocol matrix fixture for advertised/returned versions and expected outcomes.
12. **SHOULD #12 → Phase 4:** Assigned one-shot trust-epoch grant-revocation Notice ownership to Settings/lifecycle controller and added a once-only test.
13. **SHOULD #13 → Phase 3 + Phase 4:** Added denylist env override warning contract, inline Settings warning, Notice-on-save, and negative non-denylisted-key test.
14. **SHOULD #14 → Phase 4:** Added MCP settings-section dispose/subscription cleanup test for mount/unmount/plugin reload.
15. **SHOULD #15 → Phase 6:** Added manual Reconnect timer-cancellation test for pending auto-reconnect timers.
16. **SHOULD #16 → Phase 5:** Split Phase 5 into a numbered implementation sub-checklist covering registry, bridge, preamble, rendering, image placeholders, no-Undo source-keying, and MVR resilience.
17. **SHOULD #17 → Phase 2 + Phase 3 + Phase 5 + Phase 7:** Added required negative-test notes for prompt injection, DNS-rebinding deferral, and TLS-bypass attempts.

## Overview

v0.5 adds outbound Model Context Protocol (MCP) client support to `obsidian-copilot-agent`. Users can manually configure stdio and Streamable HTTP MCP servers, discover their tools, surface those tools to the Copilot SDK alongside built-in vault tools, and execute them through the existing approval UI.

The implementation is additive. With no MCP servers configured, or with every server disabled, the plugin must behave like v0.4: no spawned processes, no HTTP MCP connects, no MCP tools in the preamble or SDK surface, and the existing 724-test baseline remains green.

**Required SDK pin:** `@modelcontextprotocol/sdk@1.29.0` exactly (no caret/tilde) for v0.5. Use client-only imports (`client/index.js`, `client/streamableHttp.js`, `types.js`) plus the owned stdio transport wrapper, document the exact-pin rationale in the plan, CHANGELOG, and a valid package.json pseudo-comment field such as `"//": "MCP SDK exact-pinned for v0.5 transport review"`, and record the gzip bundle delta when the dependency lands.

**Phase shippability invariant:** MCP tool execution is impossible until the universal approval gate and stable identity model are in place. Phase 5 is the first end-user MCP execution point and must be independently shippable with the minimum viable resilience subset listed in that phase. Phase 6 is hardening + polish, not a prerequisite for avoiding dangling calls, secret leaks, or orphaned processes.

## Current State Analysis

- `src\domain\SafetyPolicy.ts` already defines `SafetySource = "mcp"`, `SafetyState.grantMcp(...)`, `mcpAutoApprove`, and top-level `decideSafety(...)`. The current MCP scope is server-name-only; v0.5 must change it to stable `(serverId, toolName, trustEpoch)` semantics.
- `src\sdk\AgentSession.ts` owns permission routing, `buildSafetyInput(...)`, pending approval resolution, stream cancellation, and custom tool registration. It is the anchor for mapping synthetic MCP tools to `source: "mcp"` before `tools/call`.
- `src\ui\ToolCallBlock.ts` already centralizes tool-call rendering and Undo visibility. v0.5 must ensure MCP blocks never render Undo and safely render MCP-controlled strings/arguments.
- `src\domain\PreambleAssembler.ts` builds the vault-aware preamble and vault tool inventory. It needs an MCP inventory/instructions extension while preserving no-MCP output.
- `src\settings\SafetySettingsStore.ts`, `src\settings\SettingsTab.ts`, and `src\main.ts` provide the existing store, settings UI, and plugin lifecycle patterns. MCP settings/manager wiring should follow these patterns rather than living in chat UI.
- `src\persistence\PersistedShape.ts`, conversation stores, and settings stores demonstrate the repo’s sibling-preserving persistence requirement.
- Current checkout baseline is v0.4+ with model picker already present; planning must preserve streaming, Stop, token rotation, Undo, raw-FS gating, vault preamble, deferred-init recovery, and send-gate precedence.

## Desired End State

- `data.json` persists additive MCP configuration: stable server id/slug, display name, enabled flag, trust epoch, transport-specific fields, timeout, status/last-error metadata, stdio env/cwd, and HTTP URL/headers including static `Authorization`.
- Volatile runtime state is never persisted: clients, child handles, timers, in-flight calls, server instructions cache, inventories, stderr ring buffer, and HTTP `Mcp-Session-Id`.
- Settings → Copilot Agent → MCP Servers lets users add, edit, remove, enable, disable, reconnect, inspect status/last error, and manage redacted static Authorization headers.
- Enabled servers connect over stdio or Streamable HTTP, advertise `2025-06-18`, accept `2025-06-18` or `2024-11-05` on supported transports, reject legacy HTTP+SSE-only servers, and perform bounded `tools/list` discovery.
- MCP tools register under deterministic `mcp__<server-id>__<tool-name>` ids, reject same-server duplicates and built-in collisions, and appear in the preamble as `<tool-name> (MCP / <display-name>)` with per-server instructions truncated to 4 KB.
- Every MCP call routes through `decideSafety(...)` as `SafetySource = "mcp"` and requires approval by default. Persistent and session grants apply only to matching `(stableServerId, toolName, trustEpoch)`.
- `tools/call` results render through the existing tool-call surface; `isError` and JSON-RPC errors are distinguishable; binary content becomes placeholders; Undo is absent for MCP.
- Crashes, timeouts, stale HTTP sessions, list changes, oversized payloads, cancellation, reconnect, and unload are deterministic and locally observable without telemetry.

## What We're NOT Doing

- Acting as an MCP server.
- OAuth/PKCE or token refresh for MCP servers.
- MCP resources, prompts, sampling, elicitation, roots, or server-initiated LLM calls.
- Legacy HTTP+SSE fallback.
- Public MCP registry browsing or config auto-import.
- Per-conversation MCP allowlists.
- Telemetry, cost accounting, or remote audit logs.
- Full image/audio passthrough to the model.
- Undo journal entries for MCP calls.
- Process sandboxing/containerization beyond the v0.5 process/env/cwd/URL controls.
- Runtime DNS-rebinding protection beyond config-time URL and per-redirect host classification; v0.5 records this deferral and negative-tests metadata/private redirect handling instead.

## Phase Status

- [ ] **Phase 1: Persistence shape + stable MCP identity** — Add additive config/grant stores, trust epoch semantics, and no-MCP persistence invariants.
- [ ] **Phase 2: SafetyPolicy gate + safe approval rendering** — Wire stable MCP identity through `decideSafety`, session grants, approval prompts, and Undo suppression before transports execute.
- [ ] **Phase 3: MCP runtime substrate + bounded discovery** — Add SDK dependency and headless stdio/Streamable HTTP runtimes with protocol, security, timeout, pagination, and size bounds.
- [ ] **Phase 4: Settings UI + plugin lifecycle orchestration** — Add the MCP Servers settings section and lifecycle actions: load, start, stop, enable/disable, remove, reconnect, unload.
- [ ] **Phase 5: Tool registry, AgentSession bridge, preamble, result rendering, and minimum viable resilience** — Publish discovered tools into SDK sessions, route calls, normalize results, update preamble, and keep live MCP execution safely shippable.
- [ ] **Phase 6: Resilience hardening + polish, cancellation, list_changed, and lifecycle bounds** — Complete advanced reconnect/backoff, atomic refresh, stale-session retry, Stop/cancel protocol polish, and bounded shutdown UX on top of Phase 5 MVR.
- [ ] **Phase 7: Documentation** — Produce Docs.md and update README/CHANGELOG with setup, security posture, bundle delta, and verification notes.

## Phase Candidates

- [x] [skipped] OAuth / PKCE for hosted MCP servers.
- [x] [skipped] MCP resources, prompts, sampling, elicitation, roots, and progress UX.
- [x] [skipped] Legacy HTTP+SSE fallback.
- [x] [skipped] Auto-import from `.vscode\mcp.json`, Claude Desktop config, or public registries.
- [x] [skipped] Per-conversation MCP allowlists or routing policies.
- [x] [skipped] Full image/audio passthrough to Copilot models.
- [x] [skipped] Dedicated MCP invocation audit log or telemetry dashboard.
- [x] [skipped] OS sandboxing/job-object hardening beyond required process shutdown and env filtering.
- [x] [deferred] Windows `.cmd` / `npx` Settings hint beyond the required spawn tests (docs include the safe `cmd /c npx` form; richer proactive hints can follow dogfooding).
- [x] [deferred] HTTP DELETE behavior before Phase 6 beyond dropping volatile session id; Phase 6 owns bounded clean shutdown.
- [x] [deferred] Separate `mcpToolNames` set in `AgentSession` if implementation finds it cleaner than registry metadata; source classification remains required either way.
- [x] [deferred] Cross-store `data.json` write-coordination stress tests beyond sibling-preservation checks.
- [x] [deferred] Stable-id/display-name/trust-fingerprint UI hints beyond the required one-shot trust-epoch Notice.
- [x] [deferred] Dedicated `McpLogger` class if `redactSensitive` + grep-based no-direct-console tests prove insufficient.

## Phase Ordering Rationale

1. **Persistence first** defines stable ids and trust epochs consumed by every later phase.
2. **Safety second** ensures any future MCP execution already has a tested universal approval path.
3. **Runtime third** proves protocol, security, and discovery behavior headlessly before UI/chat coupling.
4. **Settings fourth** surfaces configuration on top of known runtime/store contracts.
5. **Tool bridge fifth** is the first end-to-end user-visible MCP tool path, depends on the first four phases, and carries minimum viable resilience so it remains a clean stop.
6. **Resilience sixth** hardens and polishes cross-cutting active-call/list/reconnect behavior after Phase 5 is already safe to ship.
7. **Documentation last** records as-built behavior rather than planned intent.

---

## Phase 1: Persistence shape + stable MCP identity

### Goals

Add additive MCP configuration and auto-approval persistence with stable server identity and trust epochs. No transports, no settings UI, and no chat behavior change.

### Changes Required

- **`src\mcp\McpTypes.ts`** (new): persisted config types, runtime status types, redaction-safe snapshots, `McpServerId`, `McpTrustEpoch`, and transport-specific config discriminants. Server config objects MUST preserve unknown future keys on load/save so v0.6+ data can round-trip through v0.5.
- **`src\mcp\McpIdentity.ts`** (new): slug/id normalization, `computeTrustEpoch(config)`, and `formatMcpApprovalKey(serverId, toolName, trustEpoch)`. Server ids are normalized lowercase, must match `[a-z0-9_-]+`, are capped at 64 characters, must not start with `mcp__`, must not contain control characters, NULs, or path separators, and collisions on add are rejected.
- **`src\mcp\McpToolIdentity.ts`** (new in Phase 1 for identity tests, consumed in Phase 2/5): format synthetic ids as `mcp__<server-id>__<tool-name>`; parse by stripping `mcp__`, splitting only on the first `__`, and treating the remainder as the exact server-reported tool name. Tool names are passed through without case folding or trimming for id/grant formation, but names containing control characters, NUL bytes, or path separators are rejected fail-closed for that server inventory.
- **`src\settings\McpSettingsStore.ts`** (new): load/save `mcpServers`, fail-closed missing or non-array `mcpServers` to `[]`, preserve sibling keys, serialize writes, and expose mutation helpers used by later phases. Malformed `mcpServers` entries are dropped individually while valid siblings survive; a one-shot Notice names each dropped server id when available, and the cleaned shape is written on first subsequent save.
- **`src\settings\SafetySettingsStore.ts`**: evolve `mcpAutoApprove` to stable server/tool/epoch entries and add revoke helpers for server remove/repoint/rename. Pre-existing v0.4 `mcpAutoApprove` keys MUST be preserved on round-trip even when ignored by the new current-epoch lookup; cleanup of stale/older-epoch grants happens only on an explicit later save path.
- **`src\main.ts`**: instantiate the MCP settings store and expose it to later lifecycle wiring without connecting anything yet. Keep the current v0.4 `decideSafety` MCP read path green until Phase 2 replaces it with exact server/tool/epoch input.

### Required Tests

- **`src\mcp\McpIdentity.test.ts` / `src\mcp\McpToolIdentity.test.ts`**: stable server id does not change on display-name edits; id normalization lowercases and rejects invalid prefixes/control/NUL/path separators; duplicate ids on add reject; trust epoch changes on name, command, args, URL, or transport change; enable/status edits do not rotate epoch; synthetic parser preserves tool names exactly including embedded `__` and rejects hostile path/control names.
- **`src\settings\McpSettingsStore.test.ts`**: missing `mcpServers` defaults to `[]`; non-array `mcpServers` fails closed to `[]`; malformed entries are dropped while siblings and valid entries survive; one-shot Notice names dropped server ids; first save writes the cleaned shape; stdio and HTTP configs round-trip; unknown future keys under valid server entries round-trip; static `Authorization` persists; `Mcp-Session-Id` and runtime fields never serialize; sibling top-level keys survive writes.
- **`src\settings\SafetySettingsStore.test.ts`**: persistent grant lookup is exact `(serverId, toolName, trustEpoch)` using the current epoch; stale epoch fails closed; older epoch grants are ignored but not deleted until next save; pre-existing v0.4 `mcpAutoApprove` `Record<string, boolean>` keys round-trip without throwing; server removal clears only that server’s new-shape grants.

### Quality Gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual Verification

- [ ] **SC-012:** Save an HTTP config with `Authorization`, reload, and verify the header survives while `Mcp-Session-Id` is absent from `data.json`.
- [ ] **SC-019:** Grant one server/tool, rename/repoint/remove the server, and verify stale grants are revoked exactly once.
- [ ] **SC-005:** Start with no MCP config and confirm no MCP keys or runtime effects appear unless the user explicitly configures servers.
- [ ] **Corrupt persistence:** Hand-edit `data.json` to include malformed `mcpServers` entries and legacy `mcpAutoApprove`; plugin loads, valid siblings survive, dropped ids are noticed once, and the cleaned MCP shape is written on first save.

---

## Phase 2: SafetyPolicy gate + safe approval rendering

### Goals

Upgrade the universal gate to exact MCP identity and safe UI semantics before MCP transports can execute. MCP remains headless in this phase.

### Changes Required

- **`src\domain\SafetyPolicy.ts`**: extend `SafetyPolicyInput` with `mcpServerId`, `mcpToolName`, and `mcpTrustEpoch`; change `SafetyState.grantMcp(...)` and `isMcpGranted(...)` to exact server/tool/epoch scope; keep vault/builtin behavior unchanged. Missing or mismatched epoch is fail-closed (`require-approval`, never `auto-apply`).
- **`src\sdk\AgentSession.ts`**: update `buildSafetyInput(...)`, approval resolution, resolved-approval cache invalidation, and approve-for-session handling so synthetic MCP tools produce `source: "mcp"` and grant the exact MCP scope. Grant lookup must call a manager-provided synchronous accessor for the CURRENT `(stableServerId, toolName, trustEpoch)` at decision time; stale registry snapshots are not a source of truth.
- **`src\mcp\McpToolIdentity.ts`**: consume the Phase 1 parser/formatter and return source metadata to `AgentSession`; removed or `enabled:false` servers return no metadata and therefore cannot be auto-approved or dispatched.
- **`src\sdk\approvalText.ts`** (new, extracted from existing inline approval helpers): escape MCP-controlled server/tool names, descriptions, and arguments as plain text; use a shared `truncateMcpText(text, 4096)` helper for approval args, preamble instructions, and rendered MCP args/results with a visible marker.
- **`src\mcp\redactSensitive.ts`** (new): `redactSensitive(text: string): string` redacts display and persistence sinks for `Authorization` header values, `Mcp-Session-Id` (header and query-like variants), URLs containing tokens/userinfo, and stderr/env lines matching the env denylist patterns.
- **Safe-render/redaction seams**: approval modal description+args, preamble server `instructions`, tool-call args+result, Settings last-error/stderr, Notice text, and persisted status/last-error snapshots must all use plain text rendering and `redactSensitive` before display or persistence.

### Required Tests

- **`src\domain\SafetyPolicy.test.ts`**: MCP requires approval by default; persistent and session grants match only exact `(serverId, toolName, trustEpoch)`; current-epoch lookup ignores older-epoch grants; missing trust epoch and removed/disabled server metadata fail closed; `readOnlyHint`/annotations never bypass; stale trust epoch prompts.
- **`src\sdk\AgentSession.test.ts`**: synthetic MCP ids classify to `source: "mcp"`; grant lookup reads the current trust epoch synchronously at decision time; rejected calls are not dispatched; server removed between approval and dispatch rejects before `tools/call`; resolved approval short-circuit cache clears on MCP epoch rotation, disable, disconnect, and crashloop; existing vault/builtin approval tests remain green.
- **`src\mcp\redactSensitive.test.ts`**: every denylist key pattern (`GITHUB_TOKEN`, `GH_TOKEN`, `COPILOT_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AZURE_OPENAI_*`, `AWS_*`, `GCP_*`, `*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`) plus `Mcp-Session-Id`, bearer auth, URL userinfo, token query params, and SDK `Error.message`/`stack` strings are redacted.
- **Approval/prompt-injection tests**: Markdown/HTML/control-character inputs render as escaped plain text; prompt-injection strings in tool descriptions cannot alter approval policy; 4096-character truncation marker appears consistently; vault Undo remains preserved.

### Quality Gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual Verification

- [ ] **SC-003:** With test fixtures, approving one MCP tool does not approve another tool on the same server.
- [ ] **SC-004:** Malicious server/tool/args strings render as plain text, redact secrets, and truncate through the shared 4096-character helper.
- [ ] **SC-019:** After trust epoch rotation, a previously approved server/tool prompts again.

---

## Phase 3: MCP runtime substrate + bounded discovery

### Goals

Add `@modelcontextprotocol/sdk@1.29.0` and implement headless MCP runtimes for stdio and Streamable HTTP. Discover inventories with explicit protocol, timeout, pagination, I/O, URL, and environment bounds, but do not expose tools to chat yet.

### Changes Required

- **`package.json` / `package-lock.json`**: add `@modelcontextprotocol/sdk@1.29.0` exactly (no caret/tilde). Document the exact-pin rationale in the implementation PR/CHANGELOG and a valid package.json pseudo-comment field such as `"//": "MCP SDK exact-pinned for v0.5 transport review"`; treat any future SDK bump as requiring transport-security re-review.
- **Bundle-size measurement (NFR-005)**: immediately after installing the SDK and rebuilding, record the gzipped delta of `main.js` against the pre-SDK baseline. ≤80 KB passes. >80 KB requires a CHANGELOG waiver plus tree-shaking/import notes before Phase 3 can close.
- **`src\mcp\stdioEnv.ts`** (new): full-inherit-minus-denylist env builder, explicit per-server env injection after filtering, structured `explicitDenylistOverrides` warnings, Windows case-insensitive matching, macOS PATH prepend for `/usr/local/bin` and `/opt/homebrew/bin`.
- **`src\mcp\httpPolicy.ts`** (new): URL validation, TLS posture, metadata-host rejection, private-network confirmation classification, redirect cap, per-hop host-class revalidation, and Authorization stripping on cross-origin redirect. TLS uses platform defaults only; no insecure override (`rejectUnauthorized`, `insecure`, `skipTls`) is exposed.
- **Runtime HTTP fetch wrapper**: `McpServerRuntime` constructs Streamable HTTP with a custom `fetch` wrapper that sets `redirect: "manual"`, counts and revalidates each hop, rejects metadata/private disallowed redirects, drops `Authorization` on cross-origin redirects, keeps `Mcp-Session-Id` in memory only and same-origin only, and enforces TLS with no bypass options.
- **`src\mcp\transport\StdioTransport.ts`** (new): own the `child_process.spawn` call site instead of letting the SDK spawn ambient children; enforce `shell: false`, array args, env filtering, default vault-root `cwd`, per-server `cwd`, and Windows `.cmd`/`cmd /c` resolution through cross-spawn-style path lookup without shell interpolation.
- **`src\mcp\McpServerRuntime.ts`** (new): one server connection, SDK client wrapper, initialize/initialized lifecycle, `2025-06-18` advertise, supported version negotiation, `capabilities.tools !== undefined` assertion before `tools/list`, incompatible/zero-tools state when tools are absent, bounded `tools/list` pagination (10 s per page, 30 s aggregate discovery cap), instructions capture, timeouts, I/O caps, sanitized stderr ring buffer.
- **`src\mcp\McpManager.ts`** (new): enabled-runtime map, status snapshots, immutable inventory snapshots, and manual lifecycle methods; still not injected into `AgentSession`. Until Phase 6 clean HTTP DELETE lands, disable/unload drops volatile session id without persistence.
- **Redaction call-site discipline**: all runtime errors, SDK-thrown messages/stacks, status snapshots, last-error writes, stderr diagnostics, console/Notice paths, and persistence writes pass through `redactSensitive` from Phase 2.
- **`src\main.ts`**: construct the manager with stores and callbacks but keep the empty/disabled path a no-op.

### Required Tests

- **`src\mcp\stdioEnv.test.ts`**: deny exact and wildcard secret env vars (`GITHUB_TOKEN`, `GH_TOKEN`, `COPILOT_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_*`, `GCP_*`, `*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`); preserve ordinary usability vars; inject explicit env after filtering while returning denylist-override warnings; negative test for non-denylisted keys; macOS PATH order.
- **`src\mcp\transport\StdioTransport.test.ts` / `src\mcp\McpServerRuntime.test.ts`**: stdio spawn uses array args and `shell: false`; Windows-specific `.cmd`/`cmd /c` resolution treats metacharacters such as `& notepad` as literal args; per-server `cwd` is honored; initialize timeout 10 s.
- **`src\mcp\httpPolicy.test.ts`**: reject non-loopback `http://`; reject metadata IPs/hosts; require confirmation for private ranges; allow normal HTTPS; negative static assertions prove no `rejectUnauthorized`/`insecure`/`skipTls` field is accepted or passed to transport; DNS-rebinding is explicitly deferred while metadata/private redirects are rejected at runtime.
- **`src\mcp\McpServerRuntime.httpFetch.test.ts`**: same-origin 302 retains Authorization; cross-origin 302 drops Authorization; hop 4 rejects; redirect to `169.254.169.254` rejects; TLS bypass attempt fails; `Mcp-Session-Id` is not forwarded cross-origin.
- **FR-007 capability tests**: initialize sends client `capabilities: {}`; server `capabilities.tools !== undefined` is asserted before invoking `tools/list`; tools-absent servers are marked `incompatible`/zero-tools and `tools/list_changed` subscription is registered only when advertised.
- **FR-019 session-id tests**: after initialize returns `Mcp-Session-Id`, same-load `tools/list` and `tools/call` include it; it is written nowhere, absent from `data.json`, absent from diagnostics, cleared on reload/reconnect, and cleared on initialize failure.
- **FR-029 protocol matrix fixture**: table rows `{ advertised: "2025-06-18", serverReturns: "2025-06-18" | "2024-11-05" | "1999-01-01" }` assert expected accept/compat/reject outcomes across stdio, Streamable HTTP, and legacy HTTP+SSE-only fixtures.
- **`src\mcp\McpManager.test.ts`**: `tools/list` follows up to 50 pages/1000 tools, enforces 10 s page timeout and 30 s aggregate discovery cap, fails same-server duplicates, enforces 16 MiB frame/body/SSE caps and 64 KiB stderr ring buffer with truncation marker, and never persists HTTP session id.
- **Redaction/error tests**: SDK `Error.message`/`stack`, URL query tokens, bearer headers, `Mcp-Session-Id`, and stderr lines matching env denylist are redacted before status, Notice, console, and persistence sinks.

### Quality Gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] **NFR-005 bundle gate:** record gzipped `main.js` delta after SDK install; ≤80 KB or CHANGELOG waiver + tree-shaking notes.
- [ ] Grep/test confirms no direct `console.*` in `src\mcp\` outside the approved redaction/logging seam.

### Manual Verification

- [ ] **SC-009:** Launch a reference stdio server and verify env filtering, explicit env injection warning for denylisted keys, macOS PATH amendment, Windows safe command form, and absolute command behavior.
- [ ] **SC-012:** Connect/reload an HTTP server and confirm runtime `Mcp-Session-Id` is absent from persistence and diagnostics.
- [ ] **SC-013:** Fake no-response initialize/list/call paths fail at 10 s / 10 s / configured call timeout.
- [ ] **SC-014:** Oversized stdio/HTTP/SSE/stderr fixtures fail deterministically with capped diagnostics.
- [ ] **SC-017:** URL fixtures exercise loopback/private/metadata/public/redirect behavior and confirm TLS bypass options are unavailable.
- [ ] **SC-018:** Protocol matrix accepts supported `2024-11-05` servers and rejects legacy HTTP+SSE-only wording.

---

## Phase 4: Settings UI + plugin lifecycle orchestration

### Goals

Expose MCP server management in Settings and wire manager startup, shutdown, enable/disable, remove, and reconnect behavior through the plugin lifecycle without changing chat semantics.

### Changes Required

- **`src\settings\mcpServerFormLogic.ts`** (new): pure validation/normalization for server ids, required fields, command/args/url, timeouts, headers, private-network confirmation, denylist env override warnings, cwd validation, TLS-bypass absence, and redaction/reveal state.
- **`src\settings\McpServersSection.ts`** (new): DOM owner for the MCP Servers settings section: list rows, add/edit modal, remove confirmation, enable/disable, reconnect, status, last-error, tool count, inline denylist-env warning, one-shot Notice on save for denylisted explicit env keys, one-shot grant-revocation Notice on trust-epoch changes, accessibility labels, and a `dispose()` that tears down store/manager subscriptions.
- **`src\settings\SettingsTab.ts`**: mount the MCP section, subscribe to store/manager snapshots, and always call the section `dispose()` on tab close/re-render/plugin unload.
- **`src\settings\McpSettingsStore.ts`**: add controller-style mutations used by the section (`addServer`, `updateServer`, `removeServer`, `setEnabled`, `recordStatus`) and return metadata indicating whether trust epoch changed so the UI/lifecycle layer can dedupe notices.
- **`src\main.ts`**: load enabled configs after plugin bootstrap, connect asynchronously in parallel (`Promise.allSettled` style), stop disabled/removed servers, dispose all runtime connections on unload, and ensure disable/remove can settle any already-tracked in-flight MCP call once Phase 5 enables tool execution.

### Required Tests

- **`src\settings\mcpServerFormLogic.test.ts`**: stdio/HTTP required fields, id uniqueness/collision rejection, timeout bounds, Authorization redaction, URL validation result handling, inline warning for `GITHUB_TOKEN`/`OPENAI_API_KEY`/`MY_API_KEY` explicit env keys, negative no-warning for non-denylisted keys, no TLS bypass field rendered/accepted, per-server `cwd` clear error on invalid path.
- **`src\settings\McpServersSection.test.ts`**: add/edit/remove/enable/disable/reconnect flows, private-network confirmation copy, metadata-host error, redacted last-error rendering via textContent, denylist warning + Notice-on-save, one-shot trust-epoch grant-revocation Notice, accessible row labels.
- **`src\settings\McpServersSection.lifecycle.test.ts`**: mounting + unmounting the MCP server section repeatedly cleans up subscriptions/listeners; plugin reload does not leak callbacks or update destroyed DOM nodes.
- **`src\main.mcpLifecycle.test.ts`**: no servers means no spawn/fetch; enabled servers start asynchronously and in parallel; disabled servers do not connect; unload disposes manager once; remove stops active runtime and clears grants; remove/disable with active runtime settles tracked calls before late responses can render once Phase 5 enables calls.

### Quality Gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual Verification

- [ ] **SC-001:** Add a fake stdio server, reconnect successfully, and observe row status/tool count changes.
- [ ] **SC-012:** Add HTTP Authorization, reload, verify redaction by default and explicit edit/reveal behavior.
- [ ] **SC-017:** Attempt private-network, metadata-host, and TLS-bypass-like HTTP configs and verify confirmation/rejection/absence behavior.
- [ ] **SC-019:** Remove/repoint a server and verify grants clear and a one-shot Notice is shown exactly once.
- [ ] **SC-005:** All-disabled servers spawn/open no transports and no tools are visible to chat.
- [ ] **Subscription cleanup:** Open/close Settings several times, reload plugin, and confirm no duplicate MCP row updates or listener warnings appear.

---

## Phase 5: Tool registry, AgentSession bridge, preamble, result rendering, and minimum viable resilience

### Goals

Make MCP tools available to the model and UI as a clean stopping point: publish inventories into `AgentSession`, route approved calls to originating servers, render results safely, update the preamble, and include the minimum viable resilience needed for live MCP execution.

### Numbered Sub-checklist / Changes Required

1. **Tool registry — `src\mcp\McpToolRegistry.ts`** (new): immutable aggregate snapshot, synthetic id mapping that preserves exact server-reported tool names, duplicate/collision checks, built-in `mcp__` prefix guard, disabled/disconnected/removed servers contribute zero tools, and per-server instructions metadata.
2. **AgentSession bridge — `src\mcp\McpToolBridge.ts`** (new): convert MCP tools into SDK custom tools, run approval before dispatch, call `McpManager.callTool(serverId, toolName, args)`, normalize tool-call lifecycle events, and abort with `cancelled` reason if the server is removed or `enabled:false` between approval and dispatch.
3. **Preamble update — `src\domain\PreambleAssembler.ts`**: add optional MCP inventory/instructions input; render `<tool-name> (MCP / <display-name>)`; truncate instructions via shared 4096 helper; treat server instructions/tool descriptions as untrusted prompt-injection surfaces that never affect approval policy; keep no-MCP output byte-for-byte compatible with v0.4 tests where possible.
4. **Result-block rendering — `src\mcp\normalizeMcpResult.ts`, `src\ui\ToolCallBlock.ts`, `src\ui\MessageRenderer.ts`**: render text, structured content, `isError`, JSON-RPC error, resource link/resource, and redacted args/results through safe text seams; preserve existing vault tool rendering.
5. **Image/binary placeholder rendering — `normalizeMcpResult.ts`**: image/audio/blob/resource binary content becomes placeholders with decoded byte counts where possible; raw base64 is never passed through to the model or UI.
6. **No-Undo source-keying — `ToolCallBlock`**: change the Undo-button predicate from "has undoId" to "has undoId AND `source !== "mcp"`" so an MCP block with a mistakenly attached fake `undoId` still never renders Undo; vault Undo behavior is unchanged.
7. **Minimum viable resilience subset — `McpManager`, `McpServerRuntime`, `McpToolBridge`, `AgentSession`**: tool-call timeout defaults to 60 s and is capped by server config; stderr ring-buffer diagnostics are surfaced on failure after redaction; stdio/server crash during `tools/call` finalizes the tool call as an error; terminal auto-reconnect crashloop hard-disables the server until manual Reconnect; initialize is single-flight per server; disable/remove/reconnect abort in-flight calls with `cancelled` and discard late responses; until Phase 6 coalescing lands, `tools/list_changed` marks inventory stale and refreshes only between calls/turns, never mid-call.
8. **Runtime handoff — `src\main.ts` / `src\sdk\AgentSession.ts`**: inject current registry snapshot into new runtimes, define safe handoff for snapshot updates between turns, and keep built-in tool registration unchanged.

### Required Tests

- **`src\mcp\McpToolRegistry.test.ts`**: cross-server duplicate tool names create distinct ids; same-server duplicates reject inventory; exact case-sensitive tool names are preserved; hostile names with control/NUL/path separators reject; built-in collision rejects MCP and built-ins win; disabled/disconnected/removed servers contribute zero tools.
- **`src\mcp\McpToolBridge.test.ts`**: approved synthetic id routes to correct server/tool; rejection does not call server; removed/disabled server aborts with `cancelled`; 60 s default timeout finalizes failed call; server crash finalizes call error; late responses after abort are discarded; `isError` vs JSON-RPC error surfaces correctly; no `undoId` is emitted.
- **`src\mcp\McpManager.mvr.test.ts`**: initialize is single-flight; crashloop terminal state hard-disables the server and removes tools; stderr ring buffer is surfaced on failure after redaction; interim `list_changed` stale marker does not refresh mid-call.
- **`src\mcp\normalizeMcpResult.test.ts`**: mixed text/structured content is readable; image/audio/blob/resource binary placeholders do not pass raw base64; args/results use `redactSensitive` and shared truncation.
- **`src\domain\PreambleAssembler.test.ts`**: MCP rows and instructions render with attribution/truncation; prompt-injection instructions are included only as untrusted context and cannot change approval; absent instructions omit; no-MCP preamble unchanged.
- **`src\sdk\AgentSession.test.ts` / `src\ui\ToolCallBlock.test.ts`**: synthetic MCP tools go through approval, render source `mcp`, an MCP tool-call block with fake `undoId` does NOT render Undo, and vault Undo remains visible when appropriate.

### Quality Gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] Phase 5 MVR gate: fake-time timeout, crash, disable/remove abort, crashloop hard-disable, single-flight initialize, redacted stderr failure, and fake-undoId no-Undo tests all pass.

### Manual Verification

- [ ] **SC-001:** Configure a reference stdio server, see tools in preamble, approve one call, and see result without Undo.
- [ ] **SC-002:** Configure Streamable HTTP with Authorization, discover two pages, approve one call, and verify headers/session during that load.
- [ ] **SC-003:** `readOnlyHint` still prompts by default; session/persistent grant scope is exact.
- [ ] **SC-004:** Approval prompt strings are escaped and args truncate/redact through the shared 4096 helper.
- [ ] **SC-011:** Binary result content renders placeholders and no raw base64.
- [ ] **SC-016:** Two servers exposing `read_file` register distinct synthetic ids; built-in collisions are rejected.
- [ ] **MVR resilience:** Kill stdio mid-call, disable a server mid-call, trigger a fake timeout, and force crashloop; each call reaches a terminal UI state and built-in tools remain usable.

---

## Phase 6: Resilience hardening + polish, cancellation, list_changed, and lifecycle bounds

### Goals

Harden and polish failure-mode semantics on top of the Phase 5 shippable execution path: advanced reconnect/backoff UX, stale HTTP session retry, coalesced `notifications/tools/list_changed`, Stop/cancel protocol details, bounded unload, and local diagnostics.

### Changes Required

- **`src\mcp\McpReconnectPolicy.ts`** (new): retry schedule 1 s → 2 s → 4 s → 8 s → 16 s → 32 s, cap later delays at 60 s, five failed attempts in five minutes → `crashloop`, manual Reconnect reset, and manual Reconnect cancels any armed auto-reconnect timer before starting exactly one immediate attempt.
- **`src\mcp\McpNotificationQueue.ts`** (new): coalesce `tools/list_changed` per server, defer refresh until in-flight calls settle, apply registry swap atomically, preserve previous inventory on refresh failure, and replace Phase 5's stale-marker-only interim behavior.
- **`src\mcp\McpManager.ts`**: integrate reconnect policy, stale HTTP 404 handling, volatile session-id clearing on all failure/reconnect paths, bounded HTTP DELETE on shutdown, refresh rollback on failure, and idempotent disable/remove/reconnect cleanup.
- **`src\mcp\McpToolBridge.ts`**: propagate Stop/cancellation for `tools/call` when request id support exists with payload limited to `{ requestId, reason: "user_cancelled" }`; settle UI state as `cancelled`; discard late responses with `console.debug` after redaction; never send original args/chat text in cancellation payloads.
- **Initialize/discovery cancellation bounds**: unload mid-initialize aborts local waiters cleanly and never publishes the server as `connected`; Stop never sends `notifications/cancelled` for `initialize`; Stop during `tools/list` discovery cannot cancel the server request but is bounded by 10 s per page and 30 s aggregate discovery cap, and local UI state remains responsive.
- **Unload lifecycle**: on plugin unload, settle all in-flight `tools/call` waiters as `cancelled` BEFORE transports close; shut down all MCP servers in parallel; aggregate wall-clock cap is 20 s; any still-running stdio child after 20 s gets forced kill (`SIGKILL` on POSIX, Win32 equivalent) and a `console.warn` through the redaction seam.
- **`src\main.ts` / `src\sdk\AgentSession.ts`**: ensure dispose/reconnect/cancel ordering cannot leave pending approvals, hanging promises, or dangling pending tool-call UI state.
- **`src\settings\McpServersSection.ts`**: show reconnecting/crashloop/last-error/stderr diagnostics with non-color-only status, redaction on display and persistence, and safe rendering (`textContent` inside `<pre>` for stderr/last-error; no markdown/HTML rendering).

### Required Tests

- **`src\mcp\McpReconnectPolicy.test.ts`**: schedule, cap, reset on successful initialize, crashloop threshold, cancellation on disable/remove/unload, and armed auto-reconnect timer + manual Reconnect produces exactly one immediate initialize attempt.
- **`src\mcp\McpNotificationQueue.test.ts`**: three notifications during one in-flight call produce exactly one post-call refresh and no partial registry state; refresh failure preserves previous inventory.
- **`src\mcp\McpManager.resilience.test.ts`**: stdio exit mid-call, HTTP drop mid-call, stale-session 404, volatile session clearing on any initialize failure, refresh failure preserves previous inventory, built-in tools remain usable.
- **`src\mcp\McpToolBridge.test.ts` / `src\sdk\AgentSession.test.ts`**: Stop sends bounded cancellation payload only for `tools/call`; cancelled state is terminal; late responses are ignored with debug note and never reach UI; unload settles calls before transport close.
- **`src\mcp\McpServerRuntime.test.ts`**: unload mid-handshake aborts initialize and never publishes `connected`; Stop during discovery waits only within per-page 10 s and aggregate 30 s caps.
- **`src\main.mcpLifecycle.test.ts`**: unload shuts down servers in parallel with 20 s aggregate cap; stubborn stdio child receives stdin close → 5 s → SIGTERM → 5 s → forced kill as needed; idempotent and no tracked child orphaned; forced-kill warning is emitted through redaction seam.
- **`src\settings\McpServersSection.test.ts`**: server-side errors with tokenized URLs, stderr containing HTML/markdown/control chars/denylisted env-looking lines, and `Mcp-Session-Id` render as redacted plain text.

### Quality Gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] Lifecycle/cancellation gate: unload cap, pre-close cancelled settlement, initialize abort, discovery bounds, manual-reconnect timer cancel, and late-response discard tests pass.

### Manual Verification

- [ ] **SC-006:** Kill stdio mid-call; call errors/cancels deterministically, built-in tools still work, first reconnect starts after 1 s.
- [ ] **SC-007:** Drop HTTP mid-call and stale the session; no background HTTP auto-reconnect loop; next MCP call reinitializes after clearing stale session id.
- [ ] **SC-008:** Three `list_changed` notifications during an in-flight call result in one atomic post-call registry swap.
- [ ] **SC-010:** Unload with three stubborn stdio children; verify parallel shutdown completes within 20 s, late children are force-killed, and a redacted warning is logged.
- [ ] **SC-013:** Timeouts remain deterministic after cancellation/reconnect logic lands.
- [ ] **SC-015:** Five stdio failures inside five minutes enter `crashloop`; manual Reconnect cancels any pending timer, resets, and later success works.

---

## Phase 7: Documentation

### Goals

Record the as-built v0.5 architecture, user setup steps, security posture, bundle impact, and verification procedure.

### Changes Required

- **`.paw\work\mcp-client\Docs.md`**: technical reference covering stores, manager/runtime, transport/security bounds, approval scope, registry, preamble, result normalization, resilience, redaction seams, prompt-injection posture, DNS-rebinding deferral, and traceability.
- **`README.md`**: user-facing MCP server setup for stdio and Streamable HTTP, Windows `cmd /c npx` guidance, static Authorization, private-network warning, no legacy SSE fallback, no Undo for MCP calls, and a security-posture paragraph stating server instructions/tool descriptions are untrusted prompt-injection surfaces and users should review arguments before approving.
- **`CHANGELOG.md`**: v0.5 Added/Changed/Security/Migration notes, SDK version, protocol versions, bundle delta or waiver, and final test count.

### Required Tests

- No dedicated docs build is currently identified; rerun standard gates and validate examples against implemented code.

### Quality Gates

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`

### Manual Verification

- [ ] **SC-001 / SC-002:** README setup reproduces one stdio and one Streamable HTTP server.
- [ ] **SC-005:** Docs state empty/all-disabled MCP preserves v0.4 behavior.
- [ ] **SC-017 / SC-018:** Docs state URL/TLS posture, DNS-rebinding deferral, absence of TLS bypass options, and legacy HTTP+SSE rejection.
- [ ] **NFR-003:** Docs describe env denylist, redaction list, no-Undo invariant, untrusted server text, and redirect/TLS posture.
- [ ] **NFR-005:** CHANGELOG records measured gzip bundle delta or mitigation/waiver.

---

## Requirements Traceability Matrix

### Functional Requirements

| Requirement | Phase(s) | Primary tests |
|---|---:|---|
| FR-001 Server config persistence | 1, 4 | `McpSettingsStore.test.ts`, `main.mcpLifecycle.test.ts` |
| FR-002 Server config lifecycle UI | 4 | `McpServersSection.test.ts`, `mcpServerFormLogic.test.ts` |
| FR-003 Static HTTP Authorization | 1, 4 | `McpSettingsStore.test.ts`, `McpServersSection.test.ts` |
| FR-004 Stdio transport | 3, 6 | `McpServerRuntime.test.ts`, `stdioEnv.test.ts`, lifecycle tests |
| FR-005 Streamable HTTP transport | 3 | `McpServerRuntime.test.ts`, `httpPolicy.test.ts` |
| FR-006 Protocol version negotiation | 3 | `McpServerRuntime.test.ts` protocol matrix |
| FR-007 Capabilities negotiation | 3 | `McpServerRuntime.test.ts` |
| FR-008 Full `tools/list` pagination | 3 | `McpManager.test.ts`, `McpServerRuntime.test.ts` |
| FR-009 SDK tool registration | 5 | `McpToolRegistry.test.ts`, `AgentSession.test.ts` |
| FR-010 Preamble inventory/instructions | 5 | `PreambleAssembler.test.ts` |
| FR-011 Universal permission gate routing | 2, 5 | `SafetyPolicy.test.ts`, `AgentSession.test.ts` |
| FR-012 MCP auto-approval allowlist | 1, 2, 4 | `SafetySettingsStore.test.ts`, `SafetyPolicy.test.ts`, settings tests |
| FR-013 MCP calls not undoable | 2, 5 | `ToolCallBlock.test.ts`, `McpToolBridge.test.ts` |
| FR-014 Tool-call execution/rendering | 5 | `McpToolBridge.test.ts`, `normalizeMcpResult.test.ts` |
| FR-015 Binary placeholders | 5 | `normalizeMcpResult.test.ts` |
| FR-016 Crash/disconnect resilience | 5, 6 | `McpManager.mvr.test.ts`, `McpManager.resilience.test.ts` |
| FR-017 Manual reconnect | 4, 6 | `McpServersSection.test.ts`, `McpReconnectPolicy.test.ts` |
| FR-018 Stdio auto-reconnect | 5, 6 | `McpManager.mvr.test.ts`, `McpReconnectPolicy.test.ts` |
| FR-019 HTTP session id lifecycle | 3, 6 | `McpManager.test.ts`, redaction/session tests |
| FR-020 `list_changed` coalescing | 6 | `McpNotificationQueue.test.ts` |
| FR-021 Cancellation and Stop | 5, 6 | `McpToolBridge.test.ts`, `AgentSession.test.ts` |
| FR-022 Stdio env filtering | 3 | `stdioEnv.test.ts` |
| FR-023 macOS PATH amendment | 3 | `stdioEnv.test.ts` |
| FR-024 Stdio shutdown sequence | 3, 6 | `McpManager.test.ts`, `main.mcpLifecycle.test.ts` |
| FR-025 HTTP URL/TLS posture | 3, 4 | `httpPolicy.test.ts`, `mcpServerFormLogic.test.ts` |
| FR-026 MCP-disabled baseline | 1, 3, 4, 5, 6 | full `npm test`, `main.mcpLifecycle.test.ts` |
| FR-027 Request timeout policy | 3, 5, 6 | `McpServerRuntime.test.ts`, `McpToolBridge.test.ts`, `McpManager.resilience.test.ts` |
| FR-028 Bounded I/O/diagnostics | 3 | `McpServerRuntime.test.ts`, `McpManager.test.ts` |
| FR-029 `2024-11-05` compatibility / SSE rejection | 3 | protocol/transport matrix tests |
| FR-030 Approval prompt safe rendering | 2, 5 | approval text tests, `ToolCallBlock.test.ts` |

### Non-Functional Requirements

| Requirement | Phase(s) | Primary tests/checks |
|---|---:|---|
| NFR-001 Performance/bounded latency | 3, 6 | timeout tests, async discovery tests, manual responsiveness smoke |
| NFR-002 Resilience/bounded resources | 3, 6 | payload, crash, reconnect, stale-session tests |
| NFR-003 Security | 1, 2, 3, 4, 5, 6, 7 | identity, safety, env, URL, redaction, approval tests, docs posture |
| NFR-004 Compatibility | 3 | protocol matrix |
| NFR-005 Bundle size | 3, 7 | `npm run build`, measured gzip delta documented |
| NFR-006 Accessibility | 4, 5 | settings/approval UI tests and manual keyboard smoke |
| NFR-007 Baseline preservation | all | full `npm test`, no-MCP lifecycle smoke |
| NFR-008 Local observability/no telemetry | 3, 4, 6 | status/last-error/stderr/redaction tests |

### Success Criteria

| SC | Phase(s) | Verification |
|---|---:|---|
| SC-001 stdio happy path + preamble + no Undo | 4, 5 | settings, registry, preamble, bridge tests; manual stdio smoke |
| SC-002 HTTP auth + pagination + headers/session | 3, 4, 5 | HTTP runtime, settings, bridge tests; manual HTTP smoke |
| SC-003 approval by default / exact grants | 2, 5 | `SafetyPolicy.test.ts`, `AgentSession.test.ts` |
| SC-004 safe prompt rendering/truncation | 2, 5 | approval text and `ToolCallBlock` tests |
| SC-005 no-MCP v0.4 baseline | all | full suite, no-MCP lifecycle smoke |
| SC-006 stdio exit mid-call + reconnect | 5, 6 | MVR/resilience tests, manual crash smoke |
| SC-007 HTTP disconnect + next-call reconnect | 6 | resilience tests, manual HTTP drop smoke |
| SC-008 list_changed coalescing/atomic swap | 6 | `McpNotificationQueue.test.ts` |
| SC-009 env/PATH/absolute commands | 3 | `stdioEnv.test.ts` |
| SC-010 unload shutdown sequence | 6 | lifecycle fake-process tests |
| SC-011 binary placeholders | 5 | `normalizeMcpResult.test.ts` |
| SC-012 config/auth persist, session id volatile | 1, 3, 4 | store, session, redaction tests |
| SC-013 deterministic timeouts | 3, 5, 6 | fake-timer timeout tests |
| SC-014 oversized payload/stderr caps | 3 | bounded I/O tests |
| SC-015 stdio crashloop/manual reset | 5, 6 | `McpManager.mvr.test.ts`, `McpReconnectPolicy.test.ts` |
| SC-016 duplicate names/collisions | 5 | `McpToolRegistry.test.ts` |
| SC-017 URL/redirect posture | 3, 4 | `httpPolicy.test.ts`, form logic tests |
| SC-018 `2024-11-05` compatibility / SSE rejection | 3 | protocol matrix |
| SC-019 grant revocation on mutation/remove | 1, 2, 4 | store/safety/settings tests |

## Baseline Regression Matrix

| v0.4 behavior | Phase(s) most likely to disturb | Protection |
|---|---:|---|
| Streaming and Stop finalization | 5, 6 | `AgentSession.test.ts`, `ChatView` stream/Stop coverage, manual SC-006/SC-007 |
| Pending approval flow | 2, 5, 6 | `SafetyPolicy.test.ts`, `AgentSession.test.ts` |
| Undo journal and Undo button | 2, 5 | `ToolCallBlock.test.ts`, Undo regression tests |
| Token rotation / live runtimes | 4, 5, 6 | `main` lifecycle tests and full suite |
| Raw-FS and vault-tool gating | 2, 5 | existing safety/tool-gating tests |
| Vault-aware preamble | 5 | `PreambleAssembler.test.ts` no-MCP snapshot |
| Model picker / deferred init / send gate | 4, 5, 6 | existing model picker and ChatView tests |
| Persistence sibling preservation | 1, 4 | store/persistence tests |

## References

- Spec: `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\Spec.md`
- Research: `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\SpecResearch.md`
- Workflow context: `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\WorkflowContext.md`
- Per-model drafts: `C:\Repos\obsidian-copilot-agent\.paw\work\mcp-client\plans\PLAN-gpt-5.4.md`, `PLAN-gemini-3.1-pro-preview.md`, `PLAN-claude-opus-4.7.md`
- Style reference: `C:\Repos\obsidian-copilot-agent\.paw\work\model-picker\ImplementationPlan.md`
- Verified anchors: `src\domain\SafetyPolicy.ts`, `src\sdk\AgentSession.ts`, `src\ui\ToolCallBlock.ts`, `src\domain\PreambleAssembler.ts`, `src\settings\SafetySettingsStore.ts`, `src\settings\SettingsTab.ts`, `src\main.ts`








