# PLAN REVIEW - gpt-5.4

## Verdict
PASS — the plan is safety-first, phaseable, and well-anchored to the current codebase. The repo baseline is currently green (`npm test`, `npm run typecheck`, `npm run build`; Vitest 724/724), and I found no orphan FR/SC items; the remaining issues are clarity/operationalization gaps, not blockers.

## Spec Coverage
`ImplementationPlan.md:338-410` gives complete FR/NFR/SC traceability. FR-001..FR-030, NFR-001..NFR-008, and SC-001..SC-019 are all mapped; I did not find orphan functional requirements or success criteria.

Coverage is strongest for persistence/safety/runtime/tooling/resilience (`ImplementationPlan.md:82-335`). The only lighter areas are NFR-001 and NFR-005: they are mapped in the matrix (`ImplementationPlan.md:379-383`), but their verification is less operationalized in the phase text than most FRs.

## Findings

### MUST-FIX
- None.

### SHOULD-FIX
- **PR-S1 — Make capabilities-negotiation assertions explicit**
  - **Evidence:** `Spec.md:127-130,292` requires empty client capabilities and `tools.listChanged` handling. The plan maps FR-007 to `McpServerRuntime.test.ts` (`ImplementationPlan.md:350`), and Phase 3 mentions a capabilities check (`ImplementationPlan.md:162`), but the named Phase 3 tests only explicitly call out protocol/version handling and `tools`-absent behavior (`ImplementationPlan.md:168-172`).
  - **Impacted requirements:** FR-007.
  - **Why it matters:** This is a subtle protocol-contract area that is easy to regress if SDK defaults change or the notification hook is forgotten.
  - **Recommended plan change:** In Phase 3, explicitly name assertions for `capabilities: {}` on initialize and `tools/list_changed` subscription behavior inside `McpServerRuntime.test.ts`.

- **PR-S2 — Name the owner for the one-shot grant-revocation notice and test it**
  - **Evidence:** `Spec.md:154,280` requires trust-epoch-changing edits to revoke grants and notify once. The plan adds revoke helpers in Phase 1 (`ImplementationPlan.md:93`), expects the UX in manual verification (`ImplementationPlan.md:221`), and maps FR-012/SC-019 in the matrix (`ImplementationPlan.md:355,410`), but no Changes Required/Test bullet names which component emits and dedupes that notice.
  - **Impacted requirements:** FR-012, SC-019.
  - **Why it matters:** Without a named owner, this user-visible behavior is easy to omit or double-fire across rename/repoint/remove paths.
  - **Recommended plan change:** Assign the notice responsibility explicitly (store callback vs. settings section/controller vs. lifecycle layer) and add an explicit settings/lifecycle test for once-only behavior.

### CONSIDER
- **PR-C1 — Operationalize performance and bundle-size checks a bit more**
  - **Evidence:** `Spec.md:249-253,316,320` and `ImplementationPlan.md:379-383` map NFR-001/NFR-005, and the plan records bundle-delta expectations (`ImplementationPlan.md:11,317,334`), but the phases do not name a concrete async-discovery benchmark test or a repeatable gzip-measurement recipe.
  - **Impacted requirements:** NFR-001, NFR-005.
  - **Why it matters:** These are easy to claim in traceability while still getting skipped in implementation.
  - **Recommended plan change:** Add one named responsiveness check in Phase 3/6 and one explicit bundle-delta measurement step when the SDK dependency lands.

## Phase Assessment
- **Phase 1 (`ImplementationPlan.md:82-113`)** — Good stopping point; additive persistence + trust identity before any runtime side effects.
- **Phase 2 (`ImplementationPlan.md:116-147`)** — Correctly placed before tool execution; approval/UI semantics are concrete and testable.
- **Phase 3 (`ImplementationPlan.md:150-187`)** — Cohesive headless runtime/discovery phase; dense, but still shippable with strong bounds/security coverage.
- **Phase 4 (`ImplementationPlan.md:190-223`)** — Good user-management/lifecycle phase built on prior store/runtime contracts.
- **Phase 5 (`ImplementationPlan.md:226-264`)** — First end-to-end MCP exposure; large but logically cohesive around registry/bridge/preamble/rendering.
- **Phase 6 (`ImplementationPlan.md:267-304`)** — Highest integration-risk phase, but the failure-semantics boundary is still clean.
- **Phase 7 (`ImplementationPlan.md:307-335`)** — Adequate documentation closeout; now includes explicit gates and manual checks.

## Real-Code Anchor Check
Verified existing anchors:
- `src\domain\SafetyPolicy.ts` exists and already exposes `SafetySource = "mcp"`, `mcpAutoApprove`, `grantMcp(...)`, and `decideSafety(...)` (`src\domain\SafetyPolicy.ts:19-50,61-102,146-220`).
- `src\sdk\AgentSession.ts` exists and already owns MCP classification, approval deferral, and session grants (`src\sdk\AgentSession.ts:1461-1642,1672-1705`).
- `src\ui\ToolCallBlock.ts` exists and already centralizes approval rendering and Undo suppression decisions (`src\ui\ToolCallBlock.ts:45-55,79-180,183-236`).
- `src\domain\PreambleAssembler.ts` exists and is the correct preamble anchor (`src\domain\PreambleAssembler.ts:18-127`).
- `src\settings\SafetySettingsStore.ts` exists and already uses merge-and-write sibling preservation (`src\settings\SafetySettingsStore.ts:123-143,201-223`).
- `src\settings\SettingsTab.ts` exists and is the right settings UI integration point (`src\settings\SettingsTab.ts:25-203`).
- `src\main.ts` exists and already owns plugin lifecycle/load/unload wiring (`src\main.ts:60-87,651-691,713-724`).
- `src\persistence\ConversationsStore.ts` / `src\persistence\PersistedShape.ts` demonstrate the persistence patterns the plan references (`src\persistence\ConversationsStore.ts:4-14,465-471`; `src\persistence\PersistedShape.ts:89-102`).
- `src\ui\MessageRenderer.ts`, `src\lifecycle.ts`, and `src\main.toolGating.test.ts` also exist, so later-phase references are plausible.

No incorrect existing-code anchors found. `src\mcp\*` does not exist today, but every such reference is correctly marked as new work.

## Test Adequacy
Overall test planning is strong. Every FR has at least one named test hook in the matrix (`ImplementationPlan.md:342-373`), and each execution phase carries `npm test` / `npm run typecheck` / `npm run build` gates. The baseline protection is credible because the current repo actually passes those gates with 724/724 tests.

Main gaps: FR-007's capabilities assertions should be made more explicit in Phase 3, and SC-019's one-shot notice behavior should get a named test owner. NFR-001/NFR-005 checks are present but lighter than the rest.

## Risk Callouts
- **Security:** Strong coverage for env filtering, `shell: false`, private-network/metadata-host checks, redirect auth stripping, session-id redaction, safe approval rendering, and built-in collision protection (`ImplementationPlan.md:158-171,198-208,234-246,275-280`).
- **Resilience:** Strong coverage for timeouts, stale HTTP sessions, reconnect/crashloop, atomic `list_changed`, cancellation, late-response discard, and preserving previous inventory on refresh failure (`ImplementationPlan.md:162-171,275-288`).
- **Child-process lifecycle:** The stdio launch/shutdown posture is appropriately explicit, including Windows `cmd /c npx` guidance and unload escalation (`ImplementationPlan.md:159,170-171,275-289`; `SpecResearch.md:573-599`).
- **Env handling:** Good treatment of Windows case-insensitive env filtering and macOS PATH amendment (`ImplementationPlan.md:159,168,181`; `Spec.md:202-210`).
- **Watch item:** Ensure persisted status/last-error paths always use the planned redaction-safe snapshots before writing to `data.json`.
