# PLAN REVIEW - claude-opus-4.7

## Verdict
**NEEDS-REVISION (minor).** The plan is well-structured, has correct phase ordering with persistence + safety wired before any transport can execute, accurate real-code anchors, and full FR/NFR/SC coverage at the section level. A handful of gaps (no bundle-size gate for NFR-005, an unstated grant-store migration step, a few missing test hooks for FR-019/FR-029 within phase quality gates, and Phase 5 sizing risk) should be addressed before implementation.

## Spec Coverage

Every FR-001..FR-030, NFR-001..NFR-008, and SC-001..SC-019 maps to at least one phase. No orphan requirements detected. Verified mappings (phase numbers refer to ImplementationPlan.md):

| Bucket | Mapping highlights |
|---|---|
| FR-001/003/012 (persistence) | Phase 1 §82-113 |
| FR-011/013/030 (safety gate, undo suppression, safe rendering) | Phase 2 §116-147 |
| FR-004/005/006/007/008/022/023/025/027/028/029 (transports, security, bounds, protocol) | Phase 3 §150-187 |
| FR-002/017 (UI + manual reconnect surface) | Phase 4 §190-223 |
| FR-009/010/014/015 (registry, preamble, results) | Phase 5 §226-264 |
| FR-016/018/019/020/021/024 (resilience, cancel, stale session, shutdown) | Phase 6 §267-304 |
| FR-026 (MCP-disabled baseline) | Cross-cutting invariant §9, §13, Phase 1 SC-005 verification §112 |
| NFR-001..004,006..008 | covered (timeouts in P3, accessibility in P4/P6, observability in P6) |
| NFR-005 (bundle size) | **partial — see MUST-FIX F1** |
| SC-001..SC-019 | enumerated in per-phase manual verification sections |

## Findings

### MUST-FIX

**F1 — No explicit bundle-size gate satisfies NFR-005 / SC-005.**
- Evidence: Overview §11 says "record the gzip bundle delta when the dependency lands"; Phase 3 quality gates §173-177 list only `npm test / typecheck / build`. No phase has a quantitative gate or even a recorded measurement step against the ≤80 KB gzip target from Spec NFR-005 (line 253). Traceability table maps NFR-005 → SC-005 → "Bundle-size build check / documented waiver" (Spec line 320), which the plan does not wire to a concrete phase action.
- Impact: NFR-005, SC-005 measurement.
- Why it matters: NFR-005 is the only NFR with a numeric budget. If the SDK adds significantly more than 80 KB gzip, the plan should either land tree-shaking work or record a waiver in Phase 7 — neither is actionable without a measurement step.
- Recommended change: In Phase 3 Changes Required, add a one-line gzip delta measurement against the prior `main.js` baseline (e.g., `npm run build && Get-Item dist\main.js`). In Phase 3 Quality Gates, add `[ ] Record gzip delta of main.js vs v0.4 baseline; either ≤80 KB or documented waiver added to Phase 7 CHANGELOG note`.

**F2 — `mcpAutoApprove` schema migration is not specified.**
- Evidence: Phase 1 §94 says "evolve `mcpAutoApprove` to stable server/tool/epoch entries". Current code: `src\domain\SafetyPolicy.ts:49` declares `mcpAutoApprove?: Record<string, boolean>`; `SafetySettingsStore.ts` persists it. Spec §325 ("Migration / Persistence") and FR-001 prohibit silent loss of sibling state. The plan does not say whether existing v0.4 entries are dropped, migrated, or whether the field is empty in practice.
- Impact: FR-001, FR-012, NFR-007.
- Why it matters: Even though v0.4 has no MCP UI, the persisted key exists and may have stray values from tests/fixtures. Shipping Phase 1 without an explicit "drop legacy mcpAutoApprove on load; do not error" policy risks runtime parse failures or surprising regressions for early dogfooders.
- Recommended change: In Phase 1 add a bullet: "On load, ignore (drop) any legacy `mcpAutoApprove` entries that are not in the new `{serverId, toolName, trustEpoch}` shape; preserve sibling keys; log once in dev mode. Test in `SafetySettingsStore.test.ts` that legacy `Record<string, boolean>` does not throw and is discarded."

### SHOULD-FIX

**F3 — Phase 5 is the heaviest phase and risks cadence drift.**
- Evidence: Phase 5 §226-264 lists 3 new files (`McpToolRegistry.ts`, `McpToolBridge.ts`, `normalizeMcpResult.ts`), edits to `AgentSession.ts`, `PreambleAssembler.ts`, `domain\types.ts`, `ToolCallBlock.ts`, `MessageRenderer.ts`, and `main.ts`, plus 5 test files. By comparison Phase 1, 2, and 6 each touch ~3-5 files.
- Impact: Phase shippability, sizing realism.
- Why it matters: Synthesis notes §13-14 explicitly chose to keep cadence "6-8 shippable" units. Phase 5 risks ballooning into a multi-week chunk, weakening the green-stop guarantee.
- Recommended change: Either (a) annotate Phase 5 as the largest phase with an explicit sub-checklist (registry → bridge → normalizer → AgentSession wiring → preamble → UI attribution), each with `npm test` between, or (b) split into 5a (registry + AgentSession bridge headless) and 5b (preamble + result rendering UI). I recommend the annotation route to preserve the synthesis decision.

**F4 — FR-019 (HTTP session id round-trip) lacks a named test hook in Phase 3.**
- Evidence: Phase 3 tests §170-171 cover protocol matrix and pagination caps but do not explicitly assert "after `Mcp-Session-Id` is assigned, subsequent requests in the same plugin load include the header." Phase 6 covers stale-session 404 retry. FR-019 (Spec §187) requires both "send on subsequent requests" and "drop on reload".
- Impact: FR-019, SC-002, SC-007.
- Recommended change: Add a `McpServerRuntime.test.ts` bullet: "after initialize returns `Mcp-Session-Id`, subsequent `tools/list` and `tools/call` requests include the same header, and reload starts with no session id."

**F5 — FR-029 transport compatibility test list is implicit, not named.**
- Evidence: Phase 3 §170 lists "protocol matrix accepts `2025-06-18` and `2024-11-05` over supported transports; rejects legacy HTTP+SSE-only", which covers FR-029, but Spec traceability (line 314) calls this a dedicated "Protocol/transport compatibility matrix". The plan rolls it into `McpServerRuntime.test.ts` without a dedicated fixture file.
- Impact: FR-029, NFR-004, SC-018.
- Recommended change: Either keep as-is and add a `// matrix:` annotation comment, or name a `src\mcp\McpServerRuntime.protocolMatrix.test.ts`. Minor — pick whichever fits repo convention.

**F6 — Phase 1 does not state that current `decideSafety` MCP code path remains green during the data-shape change.**
- Evidence: `SafetyPolicy.ts:200-210` currently uses `toolName` (re-purposed) as the server name when source==="mcp". Phase 1 reshapes `mcpAutoApprove` and adds revoke helpers, but Phase 2 §123-126 is what extends `SafetyPolicyInput` with `mcpServerId`/`mcpToolName`/`mcpTrustEpoch` and rewrites the gate. Plan does not state how the intermediate Phase 1 build keeps the existing test green.
- Impact: Phase 1 shippability invariant §13.
- Why it matters: If Phase 1 changes the persisted shape but leaves `decideSafety` reading the old shape, gate tests in `SafetyPolicy.test.ts` could fail. Phase 1 says "No transports, no settings UI, and no chat behavior change" — this is true only if data migration tolerates the old read path or the old read path is also updated.
- Recommended change: Add a Phase 1 note: "Because v0.4 ships with `source: 'mcp'` decideSafety path that consumes the legacy `Record<string, boolean>`, keep that read path functional in Phase 1 (it will be replaced in Phase 2). Phase 1 only adds the new persisted shape and helpers; it does not remove the legacy reader."

### CONSIDER

**F7 — `src\sdk\approvalText.ts` does not exist; plan uses "or existing approval helpers."**
- Evidence: Phase 2 §127 says "`src\sdk\approvalText.ts` or existing approval helpers". I verified no `approvalText.ts` exists under `src\sdk\`. Approval prompt copy currently lives inline in `AgentSession.ts` (`buildSwapConfirmCopy` and prompt header text near line 1764).
- Recommendation: Pick one path — either commit to "new `src\sdk\approvalText.ts` extracted from `AgentSession.ts` helpers (escape + truncate)" or "in-place edits to `AgentSession.ts` approval block". The current ambiguity weakens implementation guidance for FR-030.

**F8 — Windows `cmd /c npx` guidance is in docs (Phase 7) but not in form-validation logic (Phase 4).**
- Evidence: Phase 7 §316 documents Windows stdio guidance. Spec FR-004 mandates `shell: false`. On Windows, npm/npx wrappers are `.cmd` shims that fail to spawn without `cmd /c` when shell:false. Phase 4 `mcpServerFormLogic.ts` does not mention surfacing a Windows-specific hint or `.cmd` detection.
- Recommendation: In Phase 4 form-logic tests, add a soft-warn case: "stdio command ending in `.cmd` or bare `npx`/`npm` on win32 produces a non-blocking hint suggesting `cmd /c npx ...`". Optional, but materially improves UX for the dominant stdio use case.

**F9 — Phase 5 ships before Phase 6 atomic-refresh and cancellation logic.**
- Evidence: Phase 5 surfaces tools to chat (first end-to-end user path) but `notifications/tools/list_changed` coalescing, atomic registry swap rollback, and Stop/cancel propagation land in Phase 6.
- Recommendation: In Phase 5 add an explicit interim behavior bullet: "Until Phase 6 lands, `list_changed` notifications trigger a synchronous refresh between turns only (not mid-call); Stop cancels the user-visible UI state but does not yet send `notifications/cancelled` to the server." This documents the expected intermediate behavior and prevents reviewers thinking Phase 5 alone is FR-020/FR-021 complete.

**F10 — HTTP `DELETE` on disable/unload deferred to Phase 6.**
- Evidence: Phase 6 §277 "bounded HTTP DELETE on shutdown". FR-019 also requires session lifecycle. Acceptable since Phase 3-5 just keep session-id volatile, but worth flagging.
- Recommendation: Add Phase 3 note: "Until Phase 6, disable/unload simply drops the session id; servers may carry stale sessions briefly. This is acceptable because `Mcp-Session-Id` is never persisted (SC-012)."

**F11 — Plan does not specify whether `customTool registration` in AgentSession reuses `customToolNames` Set.**
- Evidence: `AgentSession.ts:413` declares `private readonly customToolNames: Set<string>` and uses it at lines 487, 689, 1400. Plan Phase 5 §237 says "register synthetic tools alongside built-ins". It is not stated whether MCP tools are added to `customToolNames` or kept in a parallel `mcpToolNames` Set.
- Recommendation: Pick one. A separate set is cleaner for the `source: "mcp"` vs `"custom"` classification at line 1465. Recommend documenting "MCP tools registered into a new `mcpToolNames: Set<string>`; classifier at line 1647 prefers `mcp` over `custom`."

## Phase Assessment

- **Phase 1 — Persistence + identity.** Right phase to lead. Solid: stable id vs trust epoch separation, sibling-preserving store, exact-grant lookup. Gap: legacy `mcpAutoApprove` migration not stated (F2, F6).
- **Phase 2 — Safety gate + safe rendering.** Correctly precedes any transport execution; satisfies the synthesis invariant. Solid: `SafetyPolicyInput` extension, MCP id parse/format, escape + 4 KB truncation. Gap: ambiguous file home for approval text helper (F7).
- **Phase 3 — Runtime substrate + discovery.** Strong scope: env filter, URL/TLS posture, redaction, runtime, manager, protocol/version matrix, pagination/timeout/cap tests. Missing: bundle-size gate (F1), named session-id round-trip test (F4), interim HTTP DELETE statement (F10).
- **Phase 4 — Settings + lifecycle.** Good split of pure form logic from DOM section. Lifecycle test names are concrete. Gap: Windows `.cmd` hint (F8). Make sure `main.mcpLifecycle.test.ts` exercises the dispose-on-unload contract before Phase 6 hardens it.
- **Phase 5 — Tool registry + bridge + preamble + results.** Most powerful phase but also the heaviest. Coverage is correct: registry, bridge, normalizer, AgentSession wiring, preamble, UI attribution. Risks: sizing (F3), unclear interim behavior gap with Phase 6 (F9), `customToolNames` integration unspecified (F11).
- **Phase 6 — Resilience.** Crisp grouping: reconnect schedule, crashloop threshold, list_changed coalescing, stale-session 404, cancellation, shutdown sequence. Test list matches FR-016/018/020/021/024 directly.
- **Phase 7 — Documentation.** Correct trailing position. Don't forget to fold the bundle-delta waiver here (F1) and finalize the test count from a clean baseline run.

## Real-Code Anchor Check

Verified the following anchors exist in `C:\Repos\obsidian-copilot-agent\src\`:

| Anchor | Status |
|---|---|
| `src\domain\SafetyPolicy.ts` — `SafetySource` line 19, `SafetyPolicyInput` line 31, `SafetyState` line 61, `grantMcp` line 74, `isMcpGranted` line 88, `mcpAutoApprove` line 49, `decideSafety` line 146 | ✅ All present |
| `src\domain\SafetyPolicy.ts` line 200 comment "toolName here repurposed by callers to carry the MCP server" | ✅ Confirms plan's "change to stable `(serverId, toolName, trustEpoch)`" assertion |
| `src\sdk\AgentSession.ts` — `buildSafetyInput` line 1610, `source: "mcp"` line 1632, `customToolNames` line 413, `source: "custom" \| "mcp" \| "builtin"` line 1465/1647, approval prompt routing lines 1455-1561 | ✅ All present |
| `src\ui\ToolCallBlock.ts` — `shouldRenderUndoButton` line 45, `isUndoSuppressed` line 37, `source` rendering line 87/108, `sourceIcon`/`sourceLabelText` line 274+ | ✅ Anchor for "MCP-source calls never show Undo" is sound |
| `src\domain\PreambleAssembler.ts` — `assemblePreamble` line 93, `buildToolInventoryBlock`, byte limits | ✅ |
| `src\settings\SafetySettingsStore.ts`, `SettingsTab.ts` | ✅ |
| `src\persistence\PersistedShape.ts` — `source?: "custom" \| "mcp" \| "builtin"` line 32 (Phase 5 ToolCall persistence already MCP-aware) | ✅ |
| `src\main.ts`, `src\ui\MessageRenderer.ts`, `src\domain\types.ts` | ✅ |

Anchors that **do not** exist (correct: these are net-new in this plan): `src\mcp\*` (entire directory), `src\settings\McpSettingsStore.ts`, `src\settings\McpServersSection.ts`, `src\settings\mcpServerFormLogic.ts`, `src\main.mcpLifecycle.test.ts`.

Anchor with ambiguity: **`src\sdk\approvalText.ts`** (Phase 2 §127). File does not exist; plan hedges with "or existing approval helpers" (F7).

SDK version anchor verified: `SpecResearch.md:390` confirms `@modelcontextprotocol/sdk@1.29.0` is the v1.x stable. Plan matches.

## Test Adequacy

Strong coverage overall. Each FR has at least one named test hook:

| FR | Named test hook(s) |
|---|---|
| FR-001 | `McpSettingsStore.test.ts` (round-trip, sibling keys, no runtime fields) |
| FR-002 | `McpServersSection.test.ts`, `mcpServerFormLogic.test.ts` |
| FR-003 | `mcpServerFormLogic.test.ts` (Authorization redaction), `McpSettingsStore.test.ts` (persist) |
| FR-004 | `McpServerRuntime.test.ts` (spawn `shell:false`) |
| FR-005 | `McpServerRuntime.test.ts` (protocol matrix), `McpManager.test.ts` |
| FR-006 | `McpServerRuntime.test.ts` (advertise / negotiation) |
| FR-007 | `McpServerRuntime.test.ts` (tools-absent server) |
| FR-008 | `McpManager.test.ts` (50 pages / 1000 tools / 10 s page timeout) |
| FR-009 | `McpToolRegistry.test.ts`, `AgentSession.test.ts` |
| FR-010 | `PreambleAssembler.test.ts` |
| FR-011 | `SafetyPolicy.test.ts`, `AgentSession.test.ts` |
| FR-012 | `SafetyPolicy.test.ts`, `SafetySettingsStore.test.ts` |
| FR-013 | `ToolCallBlock.test.ts`, `McpToolBridge.test.ts` |
| FR-014 | `McpToolBridge.test.ts`, `ToolCallBlock.test.ts` |
| FR-015 | `normalizeMcpResult.test.ts` |
| FR-016 | `McpManager.resilience.test.ts` |
| FR-017 | `McpServersSection.test.ts`, `McpReconnectPolicy.test.ts` |
| FR-018 | `McpReconnectPolicy.test.ts` |
| FR-019 | `McpManager.test.ts` (no persist), `McpManager.resilience.test.ts` (stale 404). **Gap: no named round-trip header test (F4)** |
| FR-020 | `McpNotificationQueue.test.ts` |
| FR-021 | `McpToolBridge.test.ts`, `AgentSession.test.ts` |
| FR-022 | `stdioEnv.test.ts` (denylist matrix) |
| FR-023 | `stdioEnv.test.ts` (macOS PATH order) |
| FR-024 | `main.mcpLifecycle.test.ts` (close → SIGTERM → SIGKILL) |
| FR-025 | `httpPolicy.test.ts` (URL, metadata, redirects) |
| FR-026 | Existing 724 baseline + no-MCP fixtures in Phase 1 §111 |
| FR-027 | `McpServerRuntime.test.ts` (timeouts) |
| FR-028 | `McpManager.test.ts` (16 MiB cap, 64 KiB stderr) |
| FR-029 | `McpServerRuntime.test.ts` (protocol matrix) — **see F5** |
| FR-030 | `approvalText`/`ToolCallBlock.test.ts` (escape + truncation) |

Gaps to address: F4 (named session-id round-trip), F5 (matrix file naming nit), and an explicit `main.mcpLifecycle.test.ts` test for "remove server with active call mid-flight rejects in-flight promise" (currently only "remove stops active runtime and clears grants" is named in Phase 4 §208 — Phase 6 picks up in-flight rejection, but the boundary could be more explicit).

## Risk Callouts

**Security**
- Env denylist enumeration (Phase 3 §168) is exhaustive and matches Spec FR-022. Good.
- TLS / SSRF / metadata IP / private-network confirmation / redirect Authorization stripping all covered in `httpPolicy.test.ts`. Good.
- Approval prompt safe rendering (escape + 4 KB cap, Phase 2 §127-134) addresses FR-030 / SC-004. Good.
- Built-in collision rejection: Phase 5 §234 explicitly says "built-in `mcp__` prefix guard" and "built-ins always win". Aligns with SC-016. Good.
- **Risk:** `Authorization` header redaction in diagnostics is covered (`redact.ts`), but the plan does not state how the in-memory header is held during reveal/edit in `McpServersSection.ts` (Phase 4 §199). A keystroke logger or screen-capture risk is out of scope; just ensure the "reveal" affordance is intentional click-to-reveal, not always-visible.

**Resilience**
- Reconnect schedule (1/2/4/8/16/32, cap 60, 5-in-5-min → crashloop) matches Spec FR-018 / SC-015 exactly.
- `list_changed` coalescing per server with post-call atomic swap (Phase 6 §276) matches FR-020 / SC-008.
- HTTP stale-session 404 retry (Phase 6 §277) matches FR-019 / SC-007.

**Child-process lifecycle**
- `shell: false`, array args, stdin close → 5 s → SIGTERM → 5 s → SIGKILL (Phase 6 §288) matches FR-024 / SC-010.
- `stderr` ring buffer cap 64 KiB matches FR-028 / SC-014.
- **Risk:** Phase 4 manual lifecycle (enable/disable/remove) and Phase 6 unload converge on the same dispose path. Make sure the dispose call is idempotent (Phase 6 test says "idempotent and no tracked child orphaned" ✓) and that Phase 4's add-then-remove without ever connecting does not spawn a transient child. Worth a test in `main.mcpLifecycle.test.ts`.

**Env handling**
- Full-inherit-minus-denylist matches Spec FR-022. macOS PATH prepend of `/usr/local/bin` and `/opt/homebrew/bin` matches FR-023. Windows case-insensitive var matching is mentioned (Phase 3 §159) — make sure the test fixture exercises mixed-case `Path` vs `PATH` on win32.
- **Risk:** Wildcard denylist patterns (`*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`) are powerful but can over-block. The plan should ensure the test asserts ordinary vars like `USER_NAME`, `XDG_CONFIG_HOME`, `LANG`, and `SHELL` survive — this is implicit in "preserve ordinary usability vars" (§168) but a concrete fixture list would prevent false positives in CI.

**Observability (no telemetry)**
- Status, last-error, crashloop, stderr ring buffer surfacing in `McpServersSection.ts` with redaction (Phase 6 §280) satisfies NFR-008. Non-color-only status indicators called out for NFR-006. Good.
